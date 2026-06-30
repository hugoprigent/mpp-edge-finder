import { describe, expect, it } from "vitest";
import { parseMppTokens } from "../src/server/services/mppTextParser.js";
import type { ExtractedToken } from "../src/shared/types.js";

const t = (value: string): ExtractedToken => ({ type: "text", value });
const input = (value: string): ExtractedToken => ({ type: "input", value });

describe("parseMppTokens", () => {
  it("extracts matches, points, crowd percentages and scores from MPP visible stream", () => {
    const tokens: ExtractedToken[] = [
      t("Vendredi 26 juin"),
      t("6"),
      t("/"),
      t("6"),
      t("4e"),
      t("Tunisie"),
      t("J.3"),
      t("-"),
      t("1h00"),
      input("0"),
      input("4"),
      t("131"),
      t("2%"),
      t("123"),
      t("6%"),
      t("56"),
      t("92%"),
      t("1e"),
      t("Pays-Bas"),
      t("2e"),
      t("Japon"),
      t("J.3"),
      t("-"),
      t("1h00"),
      input("2"),
      input("0"),
      t("96"),
      t("46%"),
      t("108"),
      t("41%"),
      t("111"),
      t("13%"),
      t("3e"),
      t("Suède")
    ];

    const matches = parseMppTokens(tokens);
    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({
      homeTeam: "Tunisie",
      awayTeam: "Pays-Bas",
      scope: "90min",
      currentHomeScore: 0,
      currentAwayScore: 4,
      pointsHome: 131,
      pointsDraw: 123,
      pointsAway: 56,
      crowdAwayPct: 92
    });
    expect(matches[0].kickoffUtc).toBe("2026-06-25T23:00:00.000Z");
  });

  it("marks knockout matches as 120-minute MPP scope", () => {
    const matches = parseMppTokens([
      t("Dimanche 28 juin"),
      t("1e"),
      t("Afrique du Sud"),
      t("1/16 de finale"),
      t("-"),
      t("21h00"),
      input(""),
      input(""),
      t("141"),
      t("0%"),
      t("121"),
      t("0%"),
      t("64"),
      t("0%"),
      t("2e"),
      t("Canada")
    ]);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ phase: "1/16 de finale", scope: "120min" });
  });

  it("extracts matches from the current MPP compact stream without rank tokens", () => {
    const matches = parseMppTokens([
      t("Mercredi 1 juillet"),
      t("3"),
      t("/"),
      t("3"),
      t("Mexique"),
      t("1/16 de finale"),
      t("-"),
      t("1h00"),
      input("1"),
      input("2"),
      t("84"),
      t("75%"),
      t("108"),
      t("15%"),
      t("122"),
      t("10%"),
      t("Équateur"),
      t("Angleterre"),
      t("1/16 de finale"),
      t("-"),
      t("16h00"),
      input("2"),
      input("2"),
      t("39"),
      t("92%"),
      t("144"),
      t("6%"),
      t("181"),
      t("2%"),
      t("RD Congo")
    ]);

    expect(matches).toHaveLength(2);
    expect(matches[0]).toMatchObject({
      homeTeam: "Mexique",
      awayTeam: "Équateur",
      currentHomeScore: 1,
      currentAwayScore: 2,
      pointsAway: 122,
      crowdAwayPct: 10,
      scope: "120min"
    });
    expect(matches[0].kickoffUtc).toBe("2026-06-30T23:00:00.000Z");
  });
});
