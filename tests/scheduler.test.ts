import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/server/store.js";
import { nextMppPollMs, nextPolymarketPollMs, notifyUpcomingMatches, selectHourlyAutoPlayRecommendations } from "../src/server/services/scheduler.js";
import type { Recommendation } from "../src/shared/types.js";

describe("scheduler", () => {
  it("polls Polymarket every minute when a match is close", () => {
    const now = Date.parse("2026-06-25T20:00:00.000Z");
    expect(nextPolymarketPollMs([{ kickoffUtc: "2026-06-25T21:30:00.000Z" }], now)).toBe(60_000);
    expect(nextPolymarketPollMs([{ kickoffUtc: "2026-06-26T02:30:00.000Z" }], now)).toBe(300_000);
  });

  it("polls MPP faster when a match is close", () => {
    const now = Date.parse("2026-06-25T20:00:00.000Z");
    expect(nextMppPollMs([{ kickoffUtc: "2026-06-25T21:30:00.000Z" }], now)).toBe(120_000);
    expect(nextMppPollMs([{ kickoffUtc: "2026-06-26T02:30:00.000Z" }], now)).toBe(600_000);
  });

  it("selects only future hourly MPP updates whose score changed", () => {
    const now = Date.parse("2026-07-01T12:00:00.000Z");
    const changed = recommendationForHourly("changed", "2026-07-01T18:00:00.000Z", 0, 0, 2, 1);
    const alreadyCurrent = recommendationForHourly("current", "2026-07-01T19:00:00.000Z", 2, 1, 2, 1);
    const past = recommendationForHourly("past", "2026-07-01T11:59:00.000Z", 0, 0, 1, 0);
    const missing = { ...changed, match: { ...changed.match, id: "missing" }, outcome: "needs-data", score: undefined } as Recommendation;

    expect(selectHourlyAutoPlayRecommendations([changed, alreadyCurrent, past, missing], now).map((rec) => rec.match.id)).toEqual(["changed"]);
  });

  it("broadcasts one local T-10 alert without requiring Telegram", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpp-edge-"));
    const store = new Store(path.join(dir, "test.sqlite"));
    const kickoffUtc = new Date(Date.now() + 10 * 60_000).toISOString();
    const match = store.upsertMatch({
      kickoffUtc,
      homeTeam: "Japon",
      awayTeam: "Suède",
      phase: "J.3",
      source: "merged"
    });
    store.addMppSnapshot({
      matchId: match.id,
      pointsHome: 100,
      pointsDraw: 105,
      pointsAway: 90,
      crowdHomePct: 45,
      crowdDrawPct: 35,
      crowdAwayPct: 20,
      currentHomeScore: null,
      currentAwayScore: null,
      rawSource: "dom",
      scrapedAt: new Date().toISOString()
    });
    store.addMarketSnapshot({
      matchId: match.id,
      pHome: 0.5,
      pDraw: 0.3,
      pAway: 0.2,
      totals: [{ threshold: 2.5, pOver: 0.42, pUnder: 0.58 }],
      spreads: [],
      volume: 1000,
      liquidity: null,
      source: "polymarket",
      fetchedAt: new Date().toISOString()
    });

    expect(store.mppHistory(match.id, 5)).toHaveLength(1);
    expect(store.marketHistory(match.id, 5)).toHaveLength(1);

    const events: Array<{ event: string; payload: unknown }> = [];
    await notifyUpcomingMatches(store, (event, payload) => events.push({ event, payload }));
    await notifyUpcomingMatches(store, (event, payload) => events.push({ event, payload }));

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("notification");
    expect(events[0].payload).toMatchObject({ matchId: match.id, telegramSent: false, type: "app-10min" });
    expect(JSON.stringify(events[0].payload)).toContain("Mets");
  });
});

function recommendationForHourly(id: string, kickoffUtc: string, currentHome: number, currentAway: number, targetHome: number, targetAway: number): Recommendation {
  return {
    match: {
      id,
      kickoffUtc,
      homeTeam: "Belgique",
      awayTeam: "Sénégal",
      source: "merged",
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:00:00.000Z"
    },
    mpp: {
      id: `mpp-${id}`,
      matchId: id,
      pointsHome: 100,
      pointsDraw: 90,
      pointsAway: 80,
      crowdHomePct: 50,
      crowdDrawPct: 30,
      crowdAwayPct: 20,
      currentHomeScore: currentHome,
      currentAwayScore: currentAway,
      rawSource: "playwright",
      scrapedAt: "2026-07-01T10:00:00.000Z"
    },
    market: undefined,
    outcome: "home",
    score: { home: targetHome, away: targetAway, probability: 0.12, estimatedBonus: 5, expectedBonusPoints: 0.6, objective: 1 },
    play: { ready: true, instruction: `Mets ${targetHome}-${targetAway} pour Belgique`, homeScore: targetHome, awayScore: targetAway, x2: false },
    outcomeEvs: { home: 0, draw: 0, away: 0 },
    outcomeAnalysis: {
      home: { probability: 0.5, points: 100, expectedPoints: 50, crowdPct: 50, crowdEdge: 0, leverage: 0, attackScore: 50 },
      draw: { probability: 0.3, points: 90, expectedPoints: 27, crowdPct: 30, crowdEdge: 0, leverage: 0, attackScore: 27 },
      away: { probability: 0.2, points: 80, expectedPoints: 16, crowdPct: 20, crowdEdge: 0, leverage: 0, attackScore: 16 }
    },
    totalEv: 50.6,
    edge: 0,
    evEdge: 0,
    strategy: "chase",
    strategyScore: 51,
    strategyEdge: 0,
    leverage: 0,
    crowdEdge: 0,
    confidence: "medium",
    x2Candidate: false,
    reasons: []
  };
}
