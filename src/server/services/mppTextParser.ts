import { config } from "../config.js";
import { stableId } from "../utils.js";
import { slugify } from "../../shared/teamAliases.js";
import type { ExtractedToken, MatchScope } from "../../shared/types.js";

export type ParsedMppMatch = {
  kickoffUtc: string;
  homeTeam: string;
  awayTeam: string;
  phase: string;
  scope: MatchScope;
  currentHomeScore: number | null;
  currentAwayScore: number | null;
  pointsHome: number;
  pointsDraw: number;
  pointsAway: number;
  crowdHomePct: number;
  crowdDrawPct: number;
  crowdAwayPct: number;
  mppKey: string;
};

const monthIndex: Record<string, number> = {
  janvier: 0,
  fevrier: 1,
  février: 1,
  mars: 2,
  avril: 3,
  mai: 4,
  juin: 5,
  juillet: 6,
  aout: 7,
  août: 7,
  septembre: 8,
  octobre: 9,
  novembre: 10,
  decembre: 11,
  décembre: 11
};

const dateRegex = /^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(\d{1,2})\s+([a-zéûûôîïàèù]+)/i;
const rankRegex = /^\d+e$/i;
const timeRegex = /^(\d{1,2})h(\d{2})$/;
const phaseRegex = /^(J\.\d+|1\/16 de finale|1\/8 de finale|quart|demi|finale|petite finale)/i;

export function parseMppImport(input: string): ParsedMppMatch[] {
  const tokens = coerceTokens(input);
  return parseMppTokens(tokens);
}

export function coerceTokens(input: string): ExtractedToken[] {
  const trimmed = input.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as Array<Partial<ExtractedToken>>;
    return parsed
      .filter((item) => item && (item.type === "text" || item.type === "input"))
      .map((item) => ({ type: item.type!, value: String(item.value ?? "").trim() }));
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((value) => {
      const inputMatch = value.match(/^(?:textbox|input)\s*:?\s*"?([^"]*)"?$/i);
      return inputMatch ? { type: "input" as const, value: inputMatch[1] ?? "" } : { type: "text" as const, value };
    });
}

export function parseMppTokens(tokens: ExtractedToken[]): ParsedMppMatch[] {
  const cleanTokens = tokens
    .map((token) => ({ ...token, value: compact(token.value) }))
    .filter((token) => token.type === "input" || (token.value && token.value !== "You need to enable JavaScript to run this app."));

  const matches: ParsedMppMatch[] = [];
  let currentDate: { day: number; month: number } | null = null;
  let i = 0;

  while (i < cleanTokens.length) {
    const token = cleanTokens[i];
    const date = parseDateToken(token.value);
    if (date) {
      currentDate = date;
      i += 1;
      continue;
    }

    if (!currentDate || token.type !== "text" || !rankRegex.test(token.value)) {
      i += 1;
      continue;
    }

    const parsed = tryParseMatchAt(cleanTokens, i, currentDate);
    if (parsed) {
      matches.push(parsed.match);
      i = parsed.nextIndex;
      continue;
    }

    i += 1;
  }

  return dedupe(matches);
}

function tryParseMatchAt(
  tokens: ExtractedToken[],
  start: number,
  currentDate: { day: number; month: number }
): { match: ParsedMppMatch; nextIndex: number } | null {
  let i = start;
  if (!rankRegex.test(tokens[i]?.value ?? "")) return null;
  i += 1;

  const homeTeam = tokens[i]?.value;
  if (!homeTeam || tokens[i]?.type !== "text" || isNonTeamText(homeTeam)) return null;
  i += 1;

  const phase = tokens[i]?.value;
  if (!phase || !phaseRegex.test(phase)) return null;
  i += 1;

  if (tokens[i]?.value === "-") i += 1;

  const timeToken = tokens[i]?.value;
  const timeMatch = timeToken?.match(timeRegex);
  if (!timeMatch) return null;
  i += 1;

  const homeScoreToken = tokens[i];
  const awayScoreToken = tokens[i + 1];
  if (homeScoreToken?.type !== "input" || awayScoreToken?.type !== "input") return null;
  i += 2;

  const stats = readStats(tokens, i);
  if (!stats) return null;
  i = stats.nextIndex;

  if (!rankRegex.test(tokens[i]?.value ?? "")) return null;
  i += 1;

  const awayTeam = tokens[i]?.value;
  if (!awayTeam || tokens[i]?.type !== "text" || isNonTeamText(awayTeam)) return null;
  i += 1;

  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const kickoffUtc = toUtcIso(currentDate.day, currentDate.month, hour, minute);
  const mppKey = stableId("mpp", kickoffUtc, slugify(homeTeam), slugify(awayTeam));

  return {
    nextIndex: i,
    match: {
      kickoffUtc,
      homeTeam,
      awayTeam,
      phase,
      scope: scopeForPhase(phase),
      currentHomeScore: parseOptionalInt(homeScoreToken.value),
      currentAwayScore: parseOptionalInt(awayScoreToken.value),
      pointsHome: stats.pointsHome,
      pointsDraw: stats.pointsDraw,
      pointsAway: stats.pointsAway,
      crowdHomePct: stats.crowdHomePct,
      crowdDrawPct: stats.crowdDrawPct,
      crowdAwayPct: stats.crowdAwayPct,
      mppKey
    }
  };
}

function readStats(tokens: ExtractedToken[], start: number) {
  const values = tokens.slice(start, start + 6).map((token) => token.value);
  const [pointsHome, crowdHomePct, pointsDraw, crowdDrawPct, pointsAway, crowdAwayPct] = values;
  if (!isInteger(pointsHome) || !isPct(crowdHomePct) || !isInteger(pointsDraw) || !isPct(crowdDrawPct) || !isInteger(pointsAway) || !isPct(crowdAwayPct)) {
    return null;
  }

  return {
    nextIndex: start + 6,
    pointsHome: Number(pointsHome),
    pointsDraw: Number(pointsDraw),
    pointsAway: Number(pointsAway),
    crowdHomePct: Number(crowdHomePct.replace("%", "")),
    crowdDrawPct: Number(crowdDrawPct.replace("%", "")),
    crowdAwayPct: Number(crowdAwayPct.replace("%", ""))
  };
}

function parseDateToken(value: string): { day: number; month: number } | null {
  const match = value.match(dateRegex);
  if (!match) return null;
  const month = monthIndex[match[3].toLowerCase()];
  if (month == null) return null;
  return { day: Number(match[2]), month };
}

function toUtcIso(day: number, month: number, hour: number, minute: number): string {
  const utcMs = Date.UTC(config.mppYear, month, day, hour - config.mppLocalUtcOffsetHours, minute, 0, 0);
  return new Date(utcMs).toISOString();
}

function parseOptionalInt(value: string): number | null {
  if (!isInteger(value)) return null;
  return Number(value);
}

function isInteger(value: string | undefined): boolean {
  return value != null && /^\d+$/.test(value);
}

function isPct(value: string | undefined): boolean {
  return value != null && /^\d+(?:[.,]\d+)?%$/.test(value);
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isNonTeamText(value: string): boolean {
  return /^(Mes Pronos|Résultats|Classements|Profil|Menu|Créer|Rejoindre|Importer|Afficher stats)$/i.test(value);
}

function scopeForPhase(phase: string): MatchScope {
  return /^J\.\d+$/i.test(phase) ? "90min" : "120min";
}

function dedupe(matches: ParsedMppMatch[]): ParsedMppMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    if (seen.has(match.mppKey)) return false;
    seen.add(match.mppKey);
    return true;
  });
}
