import { stableId } from "../utils.js";
import { slugify } from "../../shared/teamAliases.js";
import type { MppResult, Outcome } from "../../shared/types.js";
import type { ParsedMppMatch } from "./mppTextParser.js";

export type ParsedMppApiData = {
  matches: ParsedMppMatch[];
  results: Array<Omit<MppResult, "id" | "matchId" | "scrapedAt"> & { mppKey: string }>;
};

type RecordLike = Record<string, unknown>;

export function parseMppApiPayload(matchesPayload: unknown, clubsPayload: unknown, championshipId: number): ParsedMppApiData {
  const clubs = readRecord(readRecord(clubsPayload).championshipClubs ?? clubsPayload);
  const apiMatches = Object.values(readRecord(readRecord(matchesPayload).championshipsCurrentMatches ?? matchesPayload));
  const matches: ParsedMppMatch[] = [];
  const results: ParsedMppApiData["results"] = [];

  for (const item of apiMatches) {
    const match = readRecord(item);
    if (Number(match.championshipId) !== championshipId) continue;

    const home = readRecord(match.home);
    const away = readRecord(match.away);
    const homeTeam = clubName(clubs, stringValue(home.clubId));
    const awayTeam = clubName(clubs, stringValue(away.clubId));
    const kickoffUtc = stringValue(match.date);
    const quotations = readRecord(match.quotations);
    const bets = readRecord(readRecord(match.stats).bets);
    if (!homeTeam || !awayTeam || !kickoffUtc || !hasQuotations(quotations)) continue;

    const phase = phaseForGameWeek(Number(match.gameWeekNumber));
    const mppKey = stableId("mpp", kickoffUtc, slugify(homeTeam), slugify(awayTeam));
    const forecast = preferredForecast(match.userForecasts);

    matches.push({
      kickoffUtc,
      homeTeam,
      awayTeam,
      phase,
      scope: phaseScope(phase),
      currentHomeScore: optionalNumber(forecast?.homeScore),
      currentAwayScore: optionalNumber(forecast?.awayScore),
      pointsHome: Number(quotations.home),
      pointsDraw: Number(quotations.draw),
      pointsAway: Number(quotations.away),
      crowdHomePct: pctFromShare(bets.home),
      crowdDrawPct: pctFromShare(bets.draw),
      crowdAwayPct: pctFromShare(bets.away),
      mppKey
    });

    const actualHomeScore = optionalNumber(home.score);
    const actualAwayScore = optionalNumber(away.score);
    if (match.period === "fullTime" && actualHomeScore != null && actualAwayScore != null) {
      const points = readRecord(forecast?.points);
      results.push({
        mppKey,
        actualHomeScore,
        actualAwayScore,
        userHomeScore: optionalNumber(forecast?.homeScore),
        userAwayScore: optionalNumber(forecast?.awayScore),
        basePoints: optionalNumber(points.base),
        exactPoints: optionalNumber(points.exact),
        extraPoints: optionalNumber(points.extra),
        bonusPoints: optionalNumber(points.bonus),
        totalPoints: optionalNumber(points.total),
        quotationPoints: quotationForOutcome(quotations, outcomeForScore(actualHomeScore, actualAwayScore)),
        period: stringValue(match.period) || null,
        matchStatus: stringValue(match.matchStatus) || null
      });
    }
  }

  return { matches: dedupeMatches(matches), results: dedupeResults(results) };
}

function preferredForecast(value: unknown): RecordLike | null {
  const forecasts = readRecord(value);
  const general = readRecord(forecasts.general);
  if (Object.keys(general).length) return general;
  const first = Object.values(forecasts).find((item) => Object.keys(readRecord(item)).length);
  return first ? readRecord(first) : null;
}

function clubName(clubs: RecordLike, clubId: string): string {
  const club = readRecord(clubs[clubId]);
  const name = readRecord(club.name);
  return stringValue(name["fr-FR"]) || stringValue(name["en-GB"]) || stringValue(club.shortName) || clubId;
}

function phaseForGameWeek(gameWeekNumber: number): string {
  if (gameWeekNumber >= 1 && gameWeekNumber <= 3) return `J.${gameWeekNumber}`;
  const labels: Record<number, string> = {
    4: "1/16 de finale",
    5: "1/8 de finale",
    6: "quart",
    7: "demi",
    8: "finale"
  };
  return labels[gameWeekNumber] ?? `J.${gameWeekNumber || "?"}`;
}

function phaseScope(phase: string): "90min" | "120min" {
  return /^J\.\d+$/i.test(phase) ? "90min" : "120min";
}

function outcomeForScore(home: number, away: number): Outcome {
  if (home > away) return "home";
  if (away > home) return "away";
  return "draw";
}

function quotationForOutcome(quotations: RecordLike, outcome: Outcome): number | null {
  const value = Number(quotations[outcome]);
  return Number.isFinite(value) ? value : null;
}

function hasQuotations(quotations: RecordLike): boolean {
  return ["home", "draw", "away"].every((key) => Number.isFinite(Number(quotations[key])));
}

function pctFromShare(value: unknown): number {
  const share = Number(value);
  return Number.isFinite(share) ? Math.round(share * 10_000) / 100 : 0;
}

function optionalNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readRecord(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : {};
}

function dedupeMatches(matches: ParsedMppMatch[]): ParsedMppMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    if (seen.has(match.mppKey)) return false;
    seen.add(match.mppKey);
    return true;
  });
}

function dedupeResults(results: ParsedMppApiData["results"]): ParsedMppApiData["results"] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.mppKey)) return false;
    seen.add(result.mppKey);
    return true;
  });
}
