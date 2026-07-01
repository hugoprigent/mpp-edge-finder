import { config } from "../config.js";
import { nowIso } from "../utils.js";
import type { Store } from "../store.js";
import { recommendMatch } from "./recommender.js";
import type {
  BacktestReport,
  BacktestRow,
  BacktestVariantSummary,
  MarketSnapshot,
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
    const preDecisionMarket = store.marketSnapshotBefore(match.id, decisionAt);
    const market = preDecisionMarket ?? (mpp ? fallbackMarketFromMpp(match.id, mpp, decisionAt) : undefined);

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
        marketSnapshotMode: market ? (preDecisionMarket ? "polymarket" : "mpp-crowd-fallback") : null,
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
      marketSnapshotMode: preDecisionMarket ? "polymarket" : "mpp-crowd-fallback",
      variants
    });
  }

  rows.sort((a, b) => new Date(b.match.kickoffUtc).getTime() - new Date(a.match.kickoffUtc).getTime());
  const playableRows = rows.filter((row) => !row.skippedReason);
  const botPoints = sum(rows.map((row) => row.botPoints));
  const userPoints = sum(rows.map((row) => row.userPoints ?? 0));

  return {
    generatedAt: nowIso(),
    leadSeconds,
    totalResults: rows.length,
    playable: playableRows.length,
    skipped: rows.length - playableRows.length,
    fallbackMarkets: rows.filter((row) => row.marketSnapshotMode === "mpp-crowd-fallback").length,
    botPoints,
    userPoints,
    deltaPoints: botPoints - userPoints,
    correctOutcomes: rows.filter((row) => row.correctOutcome).length,
    exactScores: rows.filter((row) => row.exactScore).length,
    variants: aggregateVariants(rows),
    rows
  };
}

function fallbackMarketFromMpp(matchId: string, mpp: MppSnapshot, decisionAt: string): MarketSnapshot {
  const shares = [mpp.crowdHomePct, mpp.crowdDrawPct, mpp.crowdAwayPct].map((value) => Math.max(0, value));
  const sumShares = sum(shares);
  const probabilities =
    sumShares > 0
      ? shares.map((value) => value / sumShares)
      : inversePointProbabilities([mpp.pointsHome, mpp.pointsDraw, mpp.pointsAway]);
  return {
    id: `mpp-fallback-${matchId}`,
    matchId,
    pHome: probabilities[0],
    pDraw: probabilities[1],
    pAway: probabilities[2],
    totals: [],
    spreads: [],
    volume: null,
    liquidity: null,
    source: "polymarket",
    fetchedAt: decisionAt
  };
}

function inversePointProbabilities(points: number[]): number[] {
  const weights = points.map((point) => (point > 0 ? 1 / point : 0));
  const total = sum(weights);
  return total > 0 ? weights.map((weight) => weight / total) : [1 / 3, 1 / 3, 1 / 3];
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
