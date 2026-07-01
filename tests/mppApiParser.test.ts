import { describe, expect, it } from "vitest";
import { parseMppApiPayload } from "../src/server/services/mppApiParser.js";

describe("parseMppApiPayload", () => {
  it("extracts CDM matches and completed results from the MPP API payload", () => {
    const payload = {
      mpp_championship_match_1: {
        matchId: "mpp_championship_match_1",
        championshipId: 8,
        gameWeekNumber: 4,
        date: "2026-07-03T22:00:00.000Z",
        quotations: { home: 25, draw: 165, away: 213 },
        stats: { bets: { home: 0.9, draw: 0.06, away: 0.04 } },
        home: { clubId: "home" },
        away: { clubId: "away" },
        userForecasts: { general: { homeScore: 2, awayScore: 0 } }
      },
      mpp_championship_match_2: {
        matchId: "mpp_championship_match_2",
        championshipId: 8,
        gameWeekNumber: 1,
        date: "2026-06-11T19:00:00.000Z",
        period: "fullTime",
        quotations: { home: 49, draw: 125, away: 148 },
        stats: { bets: { home: 0.85, draw: 0.08, away: 0.07 } },
        home: { clubId: "mex", score: 2 },
        away: { clubId: "rsa", score: 0 },
        userForecasts: {
          general: {
            homeScore: 2,
            awayScore: 0,
            points: { base: 49, exact: 20, extra: 0, bonus: 0, total: 69 }
          }
        }
      },
      ignored_ligue_1: {
        matchId: "ignored_ligue_1",
        championshipId: 4,
        gameWeekNumber: 34,
        date: "2026-05-09T18:00:00.000Z",
        quotations: { home: 31, draw: 157, away: 184 },
        stats: { bets: { home: 0.91, draw: 0.06, away: 0.03 } },
        home: { clubId: "lfp-home" },
        away: { clubId: "lfp-away" }
      }
    };
    const clubs = {
      championshipClubs: {
        home: { name: { "fr-FR": "Argentine" } },
        away: { name: { "fr-FR": "Cap-Vert" } },
        mex: { name: { "fr-FR": "Mexique" } },
        rsa: { name: { "fr-FR": "Afrique du Sud" } },
        "lfp-home": { name: { "fr-FR": "LFP home" } },
        "lfp-away": { name: { "fr-FR": "LFP away" } }
      }
    };

    const parsed = parseMppApiPayload(payload, clubs, 8);

    expect(parsed.matches).toHaveLength(2);
    expect(parsed.matches[0]).toMatchObject({
      homeTeam: "Argentine",
      awayTeam: "Cap-Vert",
      phase: "1/16 de finale",
      scope: "120min",
      currentHomeScore: 2,
      currentAwayScore: 0,
      pointsHome: 25,
      crowdAwayPct: 4
    });
    expect(parsed.results).toHaveLength(1);
    expect(parsed.results[0]).toMatchObject({
      actualHomeScore: 2,
      actualAwayScore: 0,
      userHomeScore: 2,
      userAwayScore: 0,
      quotationPoints: 49,
      totalPoints: 69
    });
  });
});
