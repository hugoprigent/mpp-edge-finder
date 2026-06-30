import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/server/store.js";
import { nextMppPollMs, nextPolymarketPollMs, notifyUpcomingMatches } from "../src/server/services/scheduler.js";

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
