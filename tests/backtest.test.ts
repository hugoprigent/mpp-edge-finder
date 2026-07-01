import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/server/store.js";
import { buildMppBacktest } from "../src/server/services/backtest.js";

describe("buildMppBacktest", () => {
  it("uses only snapshots available before the decision time", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mpp-backtest-"));
    const store = new Store(path.join(dir, "test.sqlite"));

    const playable = store.upsertMatch({
      kickoffUtc: "2026-07-01T10:00:00.000Z",
      homeTeam: "France",
      awayTeam: "Norvège",
      phase: "1/16 de finale",
      scope: "120min",
      source: "merged"
    });
    store.addMppSnapshot({
      matchId: playable.id,
      pointsHome: 100,
      pointsDraw: 110,
      pointsAway: 120,
      crowdHomePct: 60,
      crowdDrawPct: 25,
      crowdAwayPct: 15,
      currentHomeScore: 1,
      currentAwayScore: 0,
      rawSource: "api",
      scrapedAt: "2026-07-01T09:49:00.000Z"
    });
    store.addMarketSnapshot({
      matchId: playable.id,
      pHome: 0.8,
      pDraw: 0.12,
      pAway: 0.08,
      totals: [{ threshold: 2.5, pOver: 0.45, pUnder: 0.55 }],
      spreads: [],
      volume: 1000,
      liquidity: 500,
      source: "polymarket",
      fetchedAt: "2026-07-01T09:49:30.000Z"
    });
    store.upsertMppResult({
      matchId: playable.id,
      actualHomeScore: 1,
      actualAwayScore: 0,
      userHomeScore: 0,
      userAwayScore: 1,
      totalPoints: 0,
      scrapedAt: "2026-07-01T12:00:00.000Z"
    });

    const skipped = store.upsertMatch({
      kickoffUtc: "2026-07-01T12:00:00.000Z",
      homeTeam: "Argentine",
      awayTeam: "Cap-Vert",
      phase: "1/16 de finale",
      scope: "120min",
      source: "merged"
    });
    store.addMppSnapshot({
      matchId: skipped.id,
      pointsHome: 25,
      pointsDraw: 165,
      pointsAway: 213,
      crowdHomePct: 90,
      crowdDrawPct: 6,
      crowdAwayPct: 4,
      currentHomeScore: 2,
      currentAwayScore: 0,
      rawSource: "api",
      scrapedAt: "2026-07-01T11:55:01.000Z"
    });
    store.upsertMppResult({
      matchId: skipped.id,
      actualHomeScore: 3,
      actualAwayScore: 0,
      totalPoints: 25,
      scrapedAt: "2026-07-01T14:00:00.000Z"
    });

    const backtest = buildMppBacktest(store, 600);

    expect(backtest.totalResults).toBe(2);
    expect(backtest.playable).toBe(1);
    expect(backtest.skipped).toBe(1);
    expect(backtest.rows.find((row) => row.match.id === playable.id)?.botPoints).toBeGreaterThan(0);
    expect(backtest.rows.find((row) => row.match.id === skipped.id)?.skippedReason).toContain("avant décision");
  });
});
