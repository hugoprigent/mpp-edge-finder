import { clamp, round } from "../utils.js";
import type { Confidence, MarketSnapshot, Match, MppSnapshot, Outcome, PlayInstruction, Recommendation, ScorePick, TotalMarket } from "../../shared/types.js";

type LatestData = {
  matches: Match[];
  mppByMatch: Record<string, MppSnapshot>;
  marketByMatch: Record<string, MarketSnapshot>;
};

const outcomes: Outcome[] = ["home", "draw", "away"];

export function buildRecommendations(data: LatestData, windowHours = 96): Recommendation[] {
  const now = Date.now();
  const windowMs = windowHours * 36e5;
  const recs = data.matches
    .filter((match) => {
      const kickoff = new Date(match.kickoffUtc).getTime();
      return kickoff >= now - 2 * 36e5 && kickoff <= now + windowMs;
    })
    .map((match) => recommendMatch(match, data.mppByMatch[match.id], data.marketByMatch[match.id]));

  const x2Candidates = recs
    .filter((rec) => rec.outcome !== "needs-data" && rec.confidence !== "missing-data")
    .slice()
    .sort((a, b) => b.totalEv - a.totalEv);
  x2Candidates.forEach((rec, index) => {
    rec.x2Rank = index + 1;
    rec.x2Candidate = index === 0;
  });
  recs.forEach((rec) => {
    rec.play = buildPlayInstruction(rec.match, rec.outcome, rec.score, rec.x2Candidate);
  });

  return recs.sort(sortRecommendations);
}

function sortRecommendations(a: Recommendation, b: Recommendation): number {
  const aMissing = a.outcome === "needs-data";
  const bMissing = b.outcome === "needs-data";
  if (aMissing !== bMissing) return aMissing ? 1 : -1;
  if (!aMissing && !bMissing) {
    return b.edge - a.edge || b.totalEv - a.totalEv || kickoffSort(a, b);
  }
  return kickoffSort(a, b);
}

function kickoffSort(a: Recommendation, b: Recommendation): number {
  return new Date(a.match.kickoffUtc).getTime() - new Date(b.match.kickoffUtc).getTime();
}

export function recommendMatch(match: Match, mpp?: MppSnapshot, market?: MarketSnapshot): Recommendation {
  const emptyEvs = { home: 0, draw: 0, away: 0 };
  if (!mpp || !market) {
    return {
      match,
      mpp,
      market,
      outcome: "needs-data",
      play: buildPlayInstruction(match, "needs-data"),
      outcomeEvs: emptyEvs,
      totalEv: 0,
      edge: 0,
      confidence: "missing-data",
      x2Candidate: false,
      x2Rank: null,
      reasons: [
        !mpp ? "Données MPP manquantes: importe ou scrape la page MPP." : "",
        !market ? "Marché Polymarket manquant: lance une synchronisation Polymarket." : ""
      ].filter(Boolean)
    };
  }

  const probabilities = { home: market.pHome, draw: market.pDraw, away: market.pAway };
  const points = { home: mpp.pointsHome, draw: mpp.pointsDraw, away: mpp.pointsAway };
  const outcomeEvs = {
    home: probabilities.home * points.home,
    draw: probabilities.draw * points.draw,
    away: probabilities.away * points.away
  };
  const ranked = outcomes
    .map((outcome) => ({ outcome, ev: outcomeEvs[outcome] }))
    .sort((a, b) => b.ev - a.ev);
  const best = ranked[0];
  const second = ranked[1];
  const score = pickScore(best.outcome, market, points[best.outcome]);
  const totalEv = best.ev + (score?.expectedBonusPoints ?? 0);
  const edge = best.ev - second.ev;
  const confidence = adjustedConfidence(confidenceFor(edge, market, mpp), match);

  return {
    match,
    mpp,
    market,
    outcome: best.outcome,
    score,
    play: buildPlayInstruction(match, best.outcome, score),
    outcomeEvs: {
      home: round(outcomeEvs.home, 2),
      draw: round(outcomeEvs.draw, 2),
      away: round(outcomeEvs.away, 2)
    },
    totalEv: round(totalEv, 2),
    edge: round(edge, 2),
    confidence,
    x2Candidate: false,
    x2Rank: null,
    reasons: buildReasons(match, best.outcome, probabilities, points, edge, score)
  };
}

function buildPlayInstruction(match: Match, outcome: Outcome | "needs-data", score?: ScorePick, x2 = false): PlayInstruction {
  if (outcome === "needs-data" || !score) {
    return {
      ready: false,
      instruction: "Attends les données MPP et Polymarket avant de jouer.",
      outcomeLabel: null,
      homeScore: null,
      awayScore: null,
      x2: false
    };
  }

  const outcomeLabel = outcome === "home" ? match.homeTeam : outcome === "away" ? match.awayTeam : "nul";
  const scoreText = `${score.home}-${score.away}`;
  const base = outcome === "draw" ? `Mets ${scoreText} (nul)` : `Mets ${scoreText} pour ${outcomeLabel}`;
  return {
    ready: true,
    instruction: x2 ? `${base} + X2 sur ce match` : base,
    outcomeLabel,
    homeScore: score.home,
    awayScore: score.away,
    x2
  };
}

function adjustedConfidence(confidence: Confidence, match: Match): Confidence {
  if (match.scope !== "120min" || confidence === "missing-data") return confidence;
  if (confidence === "high") return "medium";
  return "low";
}

function confidenceFor(edge: number, market: MarketSnapshot, mpp: MppSnapshot): Confidence {
  const marketAgeHours = (Date.now() - new Date(market.fetchedAt).getTime()) / 36e5;
  const mppAgeHours = (Date.now() - new Date(mpp.scrapedAt).getTime()) / 36e5;
  if (edge >= 8 && marketAgeHours < 2 && mppAgeHours < 12) return "high";
  if (edge >= 3 && marketAgeHours < 8 && mppAgeHours < 24) return "medium";
  return "low";
}

function buildReasons(
  match: Match,
  outcome: Outcome,
  probabilities: Record<Outcome, number>,
  points: Record<Outcome, number>,
  edge: number,
  score?: ScorePick
): string[] {
  const label = outcome === "home" ? "domicile" : outcome === "draw" ? "nul" : "extérieur";
  const reasons = [
    `Meilleure espérance sur ${label}: ${(probabilities[outcome] * 100).toFixed(1)}% x ${points[outcome]} pts.`,
    `Écart vs deuxième choix: ${edge.toFixed(1)} pts.`
  ];
  if (score) {
    reasons.push(`Score exact suggéré: ${score.home}-${score.away}, bonus rareté estimé +${score.estimatedBonus}.`);
  }
  if (match.scope === "120min") {
    reasons.push("Phase à élimination directe: MPP compte 120 min hors tirs au but, confiance réduite si le marché externe est en 90 min.");
  }
  return reasons;
}

function pickScore(outcome: Outcome, market: MarketSnapshot, resultPoints: number): ScorePick {
  const lambdas = fitLambdas(market);
  let best: ScorePick | null = null;
  for (let home = 0; home <= 5; home += 1) {
    for (let away = 0; away <= 5; away += 1) {
      if (!scoreMatchesOutcome(home, away, outcome)) continue;
      const probability = poisson(home, lambdas.home) * poisson(away, lambdas.away);
      const outcomeProb = outcome === "home" ? market.pHome : outcome === "draw" ? market.pDraw : market.pAway;
      const popularityProxy = outcomeProb > 0 ? probability / outcomeProb : probability;
      const estimatedBonus = rarityBonus(popularityProxy);
      const expectedBonusPoints = probability * estimatedBonus;
      const score: ScorePick = {
        home,
        away,
        probability: round(probability, 4),
        estimatedBonus,
        expectedBonusPoints: round(expectedBonusPoints, 2)
      };
      const scoreEv = probability * (resultPoints + estimatedBonus);
      const bestEv = best ? best.probability * (resultPoints + best.estimatedBonus) : -Infinity;
      if (scoreEv > bestEv) best = score;
    }
  }
  return best ?? { home: outcome === "away" ? 0 : 1, away: outcome === "home" ? 0 : 1, probability: 0, estimatedBonus: 20, expectedBonusPoints: 0 };
}

function fitLambdas(market: MarketSnapshot): { home: number; away: number } {
  let best = { home: 1.3, away: 1.1, error: Infinity };
  for (let home = 0.2; home <= 4.2; home += 0.1) {
    for (let away = 0.2; away <= 4.2; away += 0.1) {
      const probs = resultProbabilities(home, away);
      let error =
        squared(probs.home - market.pHome) +
        squared(probs.draw - market.pDraw) +
        squared(probs.away - market.pAway);
      for (const total of usefulTotals(market.totals)) {
        error += 0.35 * squared(probOver(home + away, total.threshold) - total.pOver);
      }
      if (error < best.error) best = { home, away, error };
    }
  }
  return { home: round(best.home, 2), away: round(best.away, 2) };
}

function resultProbabilities(lambdaHome: number, lambdaAway: number): Record<Outcome, number> {
  let home = 0;
  let draw = 0;
  let away = 0;
  for (let h = 0; h <= 8; h += 1) {
    for (let a = 0; a <= 8; a += 1) {
      const p = poisson(h, lambdaHome) * poisson(a, lambdaAway);
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
    }
  }
  const sum = home + draw + away;
  return { home: home / sum, draw: draw / sum, away: away / sum };
}

function usefulTotals(totals: TotalMarket[]): TotalMarket[] {
  return totals.filter((total) => total.threshold >= 0.5 && total.threshold <= 4.5 && total.pOver > 0.02 && total.pOver < 0.98).slice(0, 4);
}

function probOver(lambdaTotal: number, threshold: number): number {
  const maxUnder = Math.floor(threshold);
  let under = 0;
  for (let goals = 0; goals <= maxUnder; goals += 1) under += poisson(goals, lambdaTotal);
  return clamp(1 - under, 0, 1);
}

function poisson(k: number, lambda: number): number {
  return (lambda ** k * Math.exp(-lambda)) / factorial(k);
}

const factorialCache = new Map<number, number>([[0, 1]]);

function factorial(value: number): number {
  const cached = factorialCache.get(value);
  if (cached) return cached;
  let result = 1;
  for (let i = 2; i <= value; i += 1) result *= i;
  factorialCache.set(value, result);
  return result;
}

function squared(value: number): number {
  return value * value;
}

function scoreMatchesOutcome(home: number, away: number, outcome: Outcome): boolean {
  if (outcome === "home") return home > away;
  if (outcome === "away") return away > home;
  return home === away;
}

function rarityBonus(popularityProxy: number): number {
  if (popularityProxy > 0.3) return 20;
  if (popularityProxy > 0.2) return 30;
  if (popularityProxy > 0.05) return 50;
  if (popularityProxy > 0.005) return 70;
  return 100;
}
