import { config } from "../config.js";
import { clamp, round } from "../utils.js";
import type {
  Confidence,
  MarketSnapshot,
  Match,
  MppSnapshot,
  Outcome,
  OutcomeAnalysis,
  PlayInstruction,
  Recommendation,
  ScorePick,
  StrategyMode,
  TotalMarket
} from "../../shared/types.js";

type LatestData = {
  matches: Match[];
  mppByMatch: Record<string, MppSnapshot>;
  marketByMatch: Record<string, MarketSnapshot>;
};

type RecommendOptions = {
  strategy?: StrategyMode;
};

const outcomes: Outcome[] = ["home", "draw", "away"];
const PAST_MATCH_GRACE_MS = 5 * 60_000;

type OutcomeCandidate = {
  outcome: Outcome;
  analysis: OutcomeAnalysis;
  score: ScorePick;
  totalEv: number;
  strategyScore: number;
};

export function buildRecommendations(data: LatestData, windowHours = 96): Recommendation[] {
  const now = Date.now();
  const windowMs = windowHours * 36e5;
  const recs = data.matches
    .filter((match) => {
      const kickoff = new Date(match.kickoffUtc).getTime();
      return kickoff >= now - PAST_MATCH_GRACE_MS && kickoff <= now + windowMs;
    })
    .map((match) => recommendMatch(match, data.mppByMatch[match.id], data.marketByMatch[match.id]));

  const x2Candidates = recs
    .filter((rec) => rec.outcome !== "needs-data" && rec.confidence !== "missing-data")
    .slice()
    .sort((a, b) => b.strategyScore - a.strategyScore || b.totalEv - a.totalEv);
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
    return b.strategyScore - a.strategyScore || b.edge - a.edge || b.totalEv - a.totalEv || kickoffSort(a, b);
  }
  return kickoffSort(a, b);
}

function kickoffSort(a: Recommendation, b: Recommendation): number {
  return new Date(a.match.kickoffUtc).getTime() - new Date(b.match.kickoffUtc).getTime();
}

export function recommendMatch(match: Match, mpp?: MppSnapshot, market?: MarketSnapshot, options: RecommendOptions = {}): Recommendation {
  const emptyEvs = { home: 0, draw: 0, away: 0 };
  const strategy = options.strategy ?? config.mppStrategyMode;
  if (!mpp || !market) {
    return {
      match,
      mpp,
      market,
      outcome: "needs-data",
      play: buildPlayInstruction(match, "needs-data"),
      outcomeEvs: emptyEvs,
      outcomeAnalysis: emptyOutcomeAnalysis(),
      totalEv: 0,
      edge: 0,
      evEdge: 0,
      strategy,
      strategyScore: 0,
      strategyEdge: 0,
      leverage: 0,
      crowdEdge: 0,
      confidence: "missing-data",
      x2Candidate: false,
      x2Rank: null,
      reasons: [
        !mpp ? "Données MPP manquantes: lance une lecture MPP." : "",
        !market ? "Marché Polymarket manquant: lance une synchronisation Polymarket." : ""
      ].filter(Boolean)
    };
  }

  const probabilities = { home: market.pHome, draw: market.pDraw, away: market.pAway };
  const points = { home: mpp.pointsHome, draw: mpp.pointsDraw, away: mpp.pointsAway };
  const crowds = { home: mpp.crowdHomePct, draw: mpp.crowdDrawPct, away: mpp.crowdAwayPct };
  const analysis = buildOutcomeAnalysis(probabilities, points, crowds, strategy);
  const candidates = outcomes
    .map((outcome): OutcomeCandidate => {
      const score = pickScore(outcome, market, strategy);
      const totalEv = analysis[outcome].expectedPoints + score.expectedBonusPoints;
      return {
        outcome,
        analysis: analysis[outcome],
        score,
        totalEv,
        strategyScore: analysis[outcome].attackScore + score.objective
      };
    })
    .sort((a, b) => b.strategyScore - a.strategyScore);
  const rankedByEv = candidates.slice().sort((a, b) => b.totalEv - a.totalEv);
  const outcomeEvs = {
    home: analysis.home.expectedPoints,
    draw: analysis.draw.expectedPoints,
    away: analysis.away.expectedPoints
  };
  const outputAnalysis = roundOutcomeAnalysis(analysis);
  const best = candidates[0];
  const second = candidates[1];
  const evAlternative = rankedByEv.find((candidate) => candidate.outcome !== best.outcome) ?? second;
  const strategyEdge = best.strategyScore - second.strategyScore;
  const evEdge = best.totalEv - evAlternative.totalEv;
  const confidence = adjustedConfidence(adjustStrategyConfidence(confidenceFor(strategyEdge, market, mpp), strategy, evEdge), match);

  return {
    match,
    mpp,
    market,
    outcome: best.outcome,
    score: best.score,
    play: buildPlayInstruction(match, best.outcome, best.score),
    outcomeEvs: {
      home: round(outcomeEvs.home, 2),
      draw: round(outcomeEvs.draw, 2),
      away: round(outcomeEvs.away, 2)
    },
    outcomeAnalysis: outputAnalysis,
    totalEv: round(best.totalEv, 2),
    edge: round(strategyEdge, 2),
    evEdge: round(evEdge, 2),
    strategy,
    strategyScore: round(best.strategyScore, 2),
    strategyEdge: round(strategyEdge, 2),
    leverage: round(best.analysis.leverage, 2),
    crowdEdge: round(best.analysis.crowdEdge, 4),
    confidence,
    x2Candidate: false,
    x2Rank: null,
    reasons: buildReasons(match, best, probabilities, points, strategyEdge, evEdge, strategy)
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

function adjustStrategyConfidence(confidence: Confidence, strategy: StrategyMode, evEdge: number): Confidence {
  if (strategy === "ev" || confidence === "missing-data" || evEdge >= 0) return confidence;
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
  best: OutcomeCandidate,
  probabilities: Record<Outcome, number>,
  points: Record<Outcome, number>,
  strategyEdge: number,
  evEdge: number,
  strategy: StrategyMode
): string[] {
  const outcome = best.outcome;
  const label = outcome === "home" ? "domicile" : outcome === "draw" ? "nul" : "extérieur";
  const crowdPct = best.analysis.crowdPct;
  const crowdEdgePct = best.analysis.crowdEdge * 100;
  const reasons = [
    `Meilleure espérance sur ${label}: ${(probabilities[outcome] * 100).toFixed(1)}% x ${points[outcome]} pts.`,
    `Score stratégie: ${best.strategyScore.toFixed(1)}; écart objectif vs deuxième: ${strategyEdge.toFixed(1)} pts; écart EV: ${evEdge.toFixed(1)} pts.`,
    `Foule MPP sur cette issue: ${crowdPct.toFixed(1)}%; edge foule: ${crowdEdgePct >= 0 ? "+" : ""}${crowdEdgePct.toFixed(1)} pts de proba.`
  ];
  if (strategy === "chase") {
    reasons.push("Mode chase: bonus aux issues peu jouées par la foule quand la probabilité marché reste défendable.");
  }
  reasons.push(
    `Score exact suggéré: ${best.score.home}-${best.score.away}, bonus rareté estimé +${best.score.estimatedBonus}, EV bonus +${best.score.expectedBonusPoints.toFixed(1)}.`
  );
  if (match.scope === "120min") {
    reasons.push("Phase à élimination directe: MPP compte 120 min hors tirs au but, confiance réduite si le marché externe est en 90 min.");
  }
  return reasons;
}

function buildOutcomeAnalysis(
  probabilities: Record<Outcome, number>,
  points: Record<Outcome, number>,
  crowds: Record<Outcome, number>,
  strategy: StrategyMode
): Record<Outcome, OutcomeAnalysis> {
  return Object.fromEntries(
    outcomes.map((outcome) => {
      const probability = clamp(probabilities[outcome], 0, 1);
      const crowdShare = clamp(crowds[outcome] / 100, 0, 1);
      const expectedPoints = probability * points[outcome];
      const leverage = points[outcome] * Math.sqrt(probability) * (1 - crowdShare);
      const crowdEdge = probability - crowdShare;
      const attackScore = strategy === "ev" ? expectedPoints : chaseAttackScore(expectedPoints, leverage, crowdEdge, probability, points[outcome]);
      return [
        outcome,
        {
          probability,
          points: points[outcome],
          crowdPct: crowds[outcome],
          expectedPoints,
          leverage,
          crowdEdge,
          attackScore
        }
      ];
    })
  ) as Record<Outcome, OutcomeAnalysis>;
}

function chaseAttackScore(expectedPoints: number, leverage: number, crowdEdge: number, probability: number, points: number): number {
  const positiveCrowdEdge = Math.max(0, crowdEdge) * points * config.mppChasePositiveCrowdEdgeWeight;
  const negativeCrowdEdge = Math.max(0, -crowdEdge) * points * config.mppChaseNegativeCrowdEdgeWeight;
  const lotteryPenalty = Math.max(0, config.mppChaseMinUsefulProbability - probability) * points * config.mppChaseLotteryPenaltyWeight;
  return expectedPoints + config.mppChaseLeverageWeight * leverage + positiveCrowdEdge - negativeCrowdEdge - lotteryPenalty;
}

function roundOutcomeAnalysis(analysis: Record<Outcome, OutcomeAnalysis>): Record<Outcome, OutcomeAnalysis> {
  return Object.fromEntries(
    outcomes.map((outcome) => [
      outcome,
      {
        probability: round(analysis[outcome].probability, 4),
        points: analysis[outcome].points,
        crowdPct: round(analysis[outcome].crowdPct, 2),
        expectedPoints: round(analysis[outcome].expectedPoints, 2),
        leverage: round(analysis[outcome].leverage, 2),
        crowdEdge: round(analysis[outcome].crowdEdge, 4),
        attackScore: round(analysis[outcome].attackScore, 2)
      }
    ])
  ) as Record<Outcome, OutcomeAnalysis>;
}

function emptyOutcomeAnalysis(): Record<Outcome, OutcomeAnalysis> {
  return Object.fromEntries(
    outcomes.map((outcome) => [
      outcome,
      {
        probability: 0,
        points: 0,
        crowdPct: 0,
        expectedPoints: 0,
        leverage: 0,
        crowdEdge: 0,
        attackScore: 0
      }
    ])
  ) as Record<Outcome, OutcomeAnalysis>;
}

function pickScore(outcome: Outcome, market: MarketSnapshot, strategy: StrategyMode): ScorePick {
  const lambdas = fitLambdas(market);
  let best: ScorePick | null = null;
  let bestObjective = -Infinity;
  for (let home = 0; home <= 5; home += 1) {
    for (let away = 0; away <= 5; away += 1) {
      if (!scoreMatchesOutcome(home, away, outcome)) continue;
      const probability = poisson(home, lambdas.home) * poisson(away, lambdas.away);
      const outcomeProb = outcome === "home" ? market.pHome : outcome === "draw" ? market.pDraw : market.pAway;
      const popularityProxy = outcomeProb > 0 ? probability / outcomeProb : probability;
      const estimatedBonus = rarityBonus(popularityProxy);
      const expectedBonusPoints = probability * estimatedBonus;
      const objective = scoreObjective(strategy, probability, estimatedBonus, popularityProxy, expectedBonusPoints, home, away, outcome);
      const score: ScorePick = {
        home,
        away,
        probability: round(probability, 4),
        estimatedBonus,
        expectedBonusPoints: round(expectedBonusPoints, 2),
        objective: round(objective, 2)
      };
      if (objective > bestObjective + 1e-9 || (Math.abs(objective - bestObjective) <= 1e-9 && best && estimatedBonus > best.estimatedBonus)) {
        best = score;
        bestObjective = objective;
      }
    }
  }
  return best ?? {
    home: outcome === "away" ? 0 : 1,
    away: outcome === "home" ? 0 : 1,
    probability: 0,
    estimatedBonus: 20,
    expectedBonusPoints: 0,
    objective: 0
  };
}

function scoreObjective(
  strategy: StrategyMode,
  probability: number,
  estimatedBonus: number,
  popularityProxy: number,
  expectedBonusPoints: number,
  home: number,
  away: number,
  outcome: Outcome
): number {
  const zeroZeroPenalty = outcome === "draw" && home === 0 && away === 0 ? config.mppScoreZeroZeroPenalty : 0;
  if (strategy === "ev") return expectedBonusPoints - zeroZeroPenalty;
  const rarityLeverage = Math.sqrt(probability) * estimatedBonus * (1 - clamp(popularityProxy, 0, 1));
  return expectedBonusPoints + config.mppChaseScoreBonusWeight * 0.05 * rarityLeverage - zeroZeroPenalty;
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
