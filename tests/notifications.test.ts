import { describe, expect, it } from "vitest";
import { formatRecommendationPlainMessage } from "../src/server/services/notifications.js";
import type { Recommendation } from "../src/shared/types.js";

describe("notifications", () => {
  it("formats a plain precise play instruction for no-account push channels", () => {
    const rec = {
      match: {
        id: "m1",
        kickoffUtc: "2026-06-25T23:00:00.000Z",
        homeTeam: "Tunisie",
        awayTeam: "Pays-Bas",
        phase: "J.3",
        source: "merged",
        createdAt: "2026-06-25T20:00:00.000Z",
        updatedAt: "2026-06-25T20:00:00.000Z"
      },
      play: {
        ready: true,
        instruction: "Mets 0-2 pour Pays-Bas + X2 sur ce match",
        outcomeLabel: "Pays-Bas",
        homeScore: 0,
        awayScore: 2,
        x2: true
      },
      outcome: "away",
      score: { home: 0, away: 2, probability: 0.12, estimatedBonus: 50, expectedBonusPoints: 6 },
      outcomeEvs: { home: 2, draw: 10, away: 55 },
      totalEv: 61,
      edge: 45,
      confidence: "high",
      x2Candidate: true,
      x2Rank: 1,
      reasons: []
    } satisfies Recommendation;

    const message = formatRecommendationPlainMessage(rec);
    expect(message).toContain("À jouer: Mets 0-2 pour Pays-Bas + X2 sur ce match");
    expect(message).not.toContain("<b>");
  });
});
