import { config } from "../config.js";
import { nowIso } from "../utils.js";
import type { Store } from "../store.js";
import { recommendMatch } from "./recommender.js";
import type {
  BacktestReport,
  BacktestRow,
  BacktestVariantSummary,
  MppResult,
  MppSnapshot,
  Outcome,
  Recommendation,
  StrategyMode
} from "../../shared/types.js";

const strategies: StrategyMode[] = ["chase", "ev"];

export function buildMppBacktest(store: Store, leadSeconds = config.mppAutoPlayLeadSeconds): BacktestReport {
  const matches = Object.fromEntries(store.getMatches().map((match) => [match.id, match]));
  const rows: BacktestRow[] = [];

  for (const result of store.mppResults()) {
    const match = matches[result.matchId];
    if (!match) continue;

    const decisionAt = new Date(new Date(match.kickoffUtc).getTime() - leadSeconds * 1000).toISOString();
    const preDecisionMpp = store.mppSnapshotBefore(match.id, decisionAt);
    const historicalMpp = preDecisionMpp ?? store.mppHistory(match.id, 1)[0];
    const mpp = historicalMpp;
    const market = store.marketSnapshotBefore(match.id, decisionAt);

    if (!mpp || !market) {
      rows.push({
        match,
        result,
        decisionAt,
        skippedReason: !mpp ? "snapshot MPP avant décision manquant" : "snapshot Polymarket avant décision manquant",
        recommendation: null,
        botPoints: 0,
        userPoints: result.totalPoints ?? 0,
        correctOutcome: false,
        exactScore: false,
        mppSnapshotAt: mpp?.scrapedAt ?? null,
        mppSnapshotMode: mpp ? (preDecisionMpp ? "pre-decision" : "historical-result") : null,
        marketSnapshotAt: market?.fetchedAt ?? null,
        variants: []
      });
      continue;
    }

    const variants = strategies.map((strategy) => {
      const rec = recommendMatch(match, mpp, market, { strategy });
      const score = scoreRecommendation(rec, result, mpp);
      return {
        strategy,
        playable: rec.outcome === "needs-data" ? 0 : 1,
        points: score.points,
        correctOutcomes: score.correctOutcome ? 1 : 0,
        exactScores: score.exactScore ? 1 : 0
      };
    });
    const rec = recommendMatch(match, mpp, market, { strategy: config.mppStrategyMode });
    const score = scoreRecommendation(rec, result, mpp);
    rows.push({
      match,
      result,
      decisionAt,
      skippedReason: null,
      recommendation: rec,
      botPoints: score.points,
      userPoints: result.totalPoints ?? 0,
      correctOutcome: score.correctOutcome,
      exactScore: score.exactScore,
      mppSnapshotAt: mpp.scrapedAt,
      mppSnapshotMode: preDecisionMpp ? "pre-decision" : "historical-result",
      marketSnapshotAt: market.fetchedAt,
      variants
    });
  }

  rows.sort((a, b) => new Date(b.match.kickoffUtc).getTime() - new Date(a.match.kickoffUtc).getTime());
  const playableRows = rows.filter((row) => !row.skippedReason);
  const botPoints = sum(playableRows.map((row) => row.botPoints));
  const userPoints = sum(playableRows.map((row) => row.userPoints ?? 0));

  return {
    generatedAt: nowIso(),
    leadSeconds,
    totalResults: rows.length,
    playable: playableRows.length,
    skipped: rows.length - playableRows.length,
    botPoints,
    userPoints,
    deltaPoints: botPoints - userPoints,
    correctOutcomes: playableRows.filter((row) => row.correctOutcome).length,
    exactScores: playableRows.filter((row) => row.exactScore).length,
    variants: aggregateVariants(playableRows),
    rows
  };
}

function scoreRecommendation(
  rec: Recommendation,
  result: MppResult,
  mpp: MppSnapshot
): { points: number; correctOutcome: boolean; exactScore: boolean } {
  if (rec.outcome === "needs-data" || !rec.score) return { points: 0, correctOutcome: false, exactScore: false };
  const actualOutcome = outcomeForScore(result.actualHomeScore, result.actualAwayScore);
  const correctOutcome = rec.outcome === actualOutcome;
  const exactScore = rec.score.home === result.actualHomeScore && rec.score.away === result.actualAwayScore;
  if (!correctOutcome) return { points: 0, correctOutcome, exactScore: false };
  const basePoints = pointsForOutcome(mpp, rec.outcome);
  return {
    points: basePoints + (exactScore ? rec.score.estimatedBonus : 0),
    correctOutcome,
    exactScore
  };
}

function aggregateVariants(rows: BacktestRow[]): BacktestVariantSummary[] {
  return strategies.map((strategy) => {
    const variants = rows.map((row) => row.variants.find((variant) => variant.strategy === strategy)).filter(Boolean) as BacktestVariantSummary[];
    return {
      strategy,
      playable: sum(variants.map((variant) => variant.playable)),
      points: sum(variants.map((variant) => variant.points)),
      correctOutcomes: sum(variants.map((variant) => variant.correctOutcomes)),
      exactScores: sum(variants.map((variant) => variant.exactScores))
    };
  });
}

function pointsForOutcome(mpp: MppSnapshot, outcome: Outcome): number {
  if (outcome === "home") return mpp.pointsHome;
  if (outcome === "away") return mpp.pointsAway;
  return mpp.pointsDraw;
}

function outcomeForScore(home: number, away: number): Outcome {
  if (home > away) return "home";
  if (away > home) return "away";
  return "draw";
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
