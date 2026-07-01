import { describe, expect, it } from "vitest";
import { buildRecommendations, recommendMatch } from "../src/server/services/recommender.js";
import type { MarketSnapshot, Match, MppSnapshot } from "../src/shared/types.js";

const match: Match = {
  id: "m1",
  kickoffUtc: "2026-06-25T23:00:00.000Z",
  homeTeam: "Japon",
  awayTeam: "Suède",
  phase: "J.3",
  source: "merged",
  createdAt: "2026-06-25T20:00:00.000Z",
  updatedAt: "2026-06-25T20:00:00.000Z"
};

const baseMpp: MppSnapshot = {
  id: "s1",
  matchId: "m1",
  pointsHome: 96,
  pointsDraw: 108,
  pointsAway: 111,
  crowdHomePct: 46,
  crowdDrawPct: 41,
  crowdAwayPct: 13,
  currentHomeScore: 2,
  currentAwayScore: 0,
  rawSource: "dom",
  scrapedAt: new Date().toISOString()
};

const baseMarket: MarketSnapshot = {
  id: "p1",
  matchId: "m1",
  pHome: 0.47,
  pDraw: 0.28,
  pAway: 0.25,
  totals: [{ threshold: 2.5, pOver: 0.5, pUnder: 0.5 }],
  spreads: [],
  volume: 1000,
  liquidity: null,
  source: "polymarket",
  fetchedAt: new Date().toISOString()
};

describe("recommendMatch", () => {
  it("chooses the best expected value outcome, not only the most probable one", () => {
    const rec = recommendMatch(match, { ...baseMpp, pointsDraw: 180 }, baseMarket);
    expect(rec.outcome).toBe("draw");
    expect(rec.outcomeEvs.draw).toBeGreaterThan(rec.outcomeEvs.home);
    expect(rec.score?.home).toBe(rec.score?.away);
    expect(rec.play.instruction).toMatch(/^Mets \d-\d \(nul\)$/);
  });

  it("does not over-pick 0-0 when 1-1 has better exact-score bonus value", () => {
    const rec = recommendMatch(
      match,
      { ...baseMpp, pointsHome: 20, pointsDraw: 220, pointsAway: 20, crowdHomePct: 40, crowdDrawPct: 15, crowdAwayPct: 45 },
      { ...baseMarket, pHome: 0.53, pDraw: 0.27, pAway: 0.2, totals: [] }
    );

    expect(rec.outcome).toBe("draw");
    expect(rec.score).toMatchObject({ home: 1, away: 1 });
  });

  it("returns a missing-data recommendation when MPP is absent", () => {
    const rec = recommendMatch(match, undefined, baseMarket);
    expect(rec.outcome).toBe("needs-data");
    expect(rec.confidence).toBe("missing-data");
    expect(rec.play.ready).toBe(false);
  });

  it("reduces confidence for knockout matches scoped to 120 minutes", () => {
    const rec = recommendMatch({ ...match, phase: "1/16 de finale", scope: "120min" }, { ...baseMpp, pointsHome: 10, pointsDraw: 10, pointsAway: 180 }, {
      ...baseMarket,
      pHome: 0.05,
      pDraw: 0.1,
      pAway: 0.85
    });

    expect(rec.confidence).toBe("medium");
    expect(rec.reasons.join(" ")).toContain("120 min");
  });

  it("keeps high confidence for group-stage 90-minute matches", () => {
    const rec = recommendMatch({ ...match, scope: "90min" }, { ...baseMpp, pointsHome: 10, pointsDraw: 10, pointsAway: 180 }, {
      ...baseMarket,
      pHome: 0.05,
      pDraw: 0.1,
      pAway: 0.85
    });

    expect(rec.confidence).toBe("high");
  });

  it("uses crowd leverage in chase mode when an underpicked outcome is still valuable", () => {
    const rec = recommendMatch(
      { ...match, scope: "90min" },
      {
        ...baseMpp,
        pointsHome: 100,
        pointsDraw: 150,
        pointsAway: 130,
        crowdHomePct: 80,
        crowdDrawPct: 15,
        crowdAwayPct: 5
      },
      {
        ...baseMarket,
        pHome: 0.5,
        pDraw: 0.15,
        pAway: 0.35
      }
    );

    expect(rec.strategy).toBe("chase");
    expect(rec.outcome).toBe("away");
    expect(rec.evEdge).toBeLessThan(0);
    expect(rec.outcomeAnalysis.away.crowdEdge).toBeGreaterThan(0);
    expect(rec.strategyScore).toBeGreaterThan(rec.outcomeAnalysis.home.attackScore);
  });

  it("sorts actionable recommendations by strategy score before missing data", () => {
    const soon = new Date(Date.now() + 36e5).toISOString();
    const lowEdge = { ...match, id: "low", kickoffUtc: soon, homeTeam: "Japon", awayTeam: "Suède" };
    const highEdge = { ...match, id: "high", kickoffUtc: soon, homeTeam: "Tunisie", awayTeam: "Pays-Bas" };
    const missing = { ...match, id: "missing", kickoffUtc: soon, homeTeam: "France", awayTeam: "Norvège" };

    const recs = buildRecommendations({
      matches: [lowEdge, missing, highEdge],
      mppByMatch: {
        low: { ...baseMpp, id: "mpp-low", matchId: "low", pointsHome: 100, pointsDraw: 100, pointsAway: 100 },
        high: { ...baseMpp, id: "mpp-high", matchId: "high", pointsHome: 25, pointsDraw: 25, pointsAway: 150 }
      },
      marketByMatch: {
        low: { ...baseMarket, id: "market-low", matchId: "low", pHome: 0.4, pDraw: 0.3, pAway: 0.3 },
        high: { ...baseMarket, id: "market-high", matchId: "high", pHome: 0.05, pDraw: 0.1, pAway: 0.85 }
      }
    });

    expect(recs.map((rec) => rec.match.id)).toEqual(["high", "low", "missing"]);
    expect(recs[0].strategyScore).toBeGreaterThan(recs[1].strategyScore);
    expect(recs[0].play.instruction).toContain("X2 sur ce match");
  });
});
