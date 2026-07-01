import { config } from "../config.js";
import { round } from "../utils.js";
import { matchSimilarity, teamKey, teamsMatch } from "../../shared/teamAliases.js";
import type { MarketSnapshot, Match, Outcome, SyncResult } from "../../shared/types.js";
import type { Store } from "../store.js";

type GammaEvent = {
  id?: string;
  slug?: string;
  title?: string;
  endDate?: string;
  volume?: number;
  liquidity?: number;
  markets?: GammaMarket[];
};

type GammaMarket = {
  slug?: string;
  question?: string;
  endDate?: string;
  gameStartTime?: string;
  clobTokenIds?: string | string[];
  outcomes?: string | string[];
};

type MatchedGammaEvent = {
  event: GammaEvent;
  homeTeam: string;
  awayTeam: string;
  kickoffUtc: string;
  distance: number;
  score: number;
};

type PricePoint = { t: number; p: number };

const GAMMA_SERIES_ID = "11433";
const HISTORY_FIDELITY_MINUTES = 5;
const EVENT_MATCH_WINDOW_MS = 18 * 36e5;

export async function backfillHistoricalPolymarket(store: Store, leadSeconds = config.mppAutoPlayLeadSeconds): Promise<SyncResult> {
  const events = await fetchFifwcEvents();
  const matches = store.getMatches();
  const resultsByMatch = store.latestMppResults();
  let matchedMarkets = 0;
  let skipped = 0;

  for (const match of matches) {
    const result = resultsByMatch[match.id];
    if (!result) continue;

    const candidate = findGammaEvent(match, events);
    if (!candidate) {
      skipped += 1;
      continue;
    }

    const normalizedMatch = store.upsertMatch({
      kickoffUtc: candidate.kickoffUtc,
      homeTeam: candidate.homeTeam,
      awayTeam: candidate.awayTeam,
      source: "polymarket",
      polymarketSlug: candidate.event.slug ?? null
    });
    const decisionAt = decisionTime(normalizedMatch, candidate.kickoffUtc, leadSeconds);
    const snapshot = await historicalSnapshotForMatch(normalizedMatch, candidate, decisionAt).catch(() => null);
    if (!snapshot || duplicateHistoricalSnapshot(store, normalizedMatch.id, snapshot)) {
      skipped += 1;
      continue;
    }

    store.addMarketSnapshot(snapshot);
    matchedMarkets += 1;
  }

  return {
    ok: true,
    message: `${matchedMarkets} cotes Polymarket historiques importées avant match${skipped ? `, ${skipped} ignorées` : ""}.`,
    matchedMarkets
  };
}

async function fetchFifwcEvents(): Promise<MatchedGammaEvent[]> {
  const events: GammaEvent[] = [];
  for (const closed of [true, false]) {
    for (let offset = 0; offset <= 1000; offset += 100) {
      const url = `https://gamma-api.polymarket.com/events?series_id=${GAMMA_SERIES_ID}&limit=100&offset=${offset}&closed=${closed}`;
      const response = await fetch(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Gamma ${response.status}: ${await response.text()}`);
      const page = (await response.json()) as GammaEvent[];
      events.push(...page);
      if (page.length < 100) break;
    }
  }

  return dedupeEvents(events)
    .map(parseMainMatchEvent)
    .filter(Boolean) as MatchedGammaEvent[];
}

function dedupeEvents(events: GammaEvent[]): GammaEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = event.slug || event.id || event.title || "";
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseMainMatchEvent(event: GammaEvent): MatchedGammaEvent | null {
  const title = clean(event.title);
  if (!title || title.includes(" - ")) return null;
  const teams = title.split(/\s+vs\.?\s+/i).map(clean);
  if (teams.length !== 2 || !teams[0] || !teams[1]) return null;
  const kickoffUtc = eventKickoff(event);
  if (!kickoffUtc) return null;
  const markets = event.markets ?? [];
  if (!findMarketForOutcome({ ...event, markets }, "draw", teams[0], teams[1])) return null;
  if (!findMarketForOutcome({ ...event, markets }, "home", teams[0], teams[1])) return null;
  if (!findMarketForOutcome({ ...event, markets }, "away", teams[0], teams[1])) return null;

  return {
    event,
    homeTeam: teams[0],
    awayTeam: teams[1],
    kickoffUtc,
    distance: 0,
    score: 0
  };
}

function eventKickoff(event: GammaEvent): string | null {
  const marketTime = (event.markets ?? []).map((market) => market.gameStartTime || market.endDate).find(Boolean);
  const value = marketTime || event.endDate;
  if (!value) return null;
  const date = parseGammaDate(value);
  return date ? date.toISOString() : null;
}

function parseGammaDate(value: string): Date | null {
  const normalized = value.includes(" ") ? value.replace(" ", "T") : value;
  const candidates = [
    value,
    normalized,
    normalized.replace(/\+00$/, "Z"),
    normalized.replace(/\+0000$/, "Z"),
    normalized.replace(/\+00:00$/, "Z")
  ];
  for (const candidate of candidates) {
    const date = new Date(candidate);
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}

function findGammaEvent(match: Match, events: MatchedGammaEvent[]): MatchedGammaEvent | null {
  const matchTime = new Date(match.kickoffUtc).getTime();
  return (
    events
      .map((candidate) => {
        const direct = matchSimilarity(match.homeTeam, candidate.homeTeam) + matchSimilarity(match.awayTeam, candidate.awayTeam);
        const reversed = matchSimilarity(match.homeTeam, candidate.awayTeam) + matchSimilarity(match.awayTeam, candidate.homeTeam);
        const distance = Math.abs(matchTime - new Date(candidate.kickoffUtc).getTime());
        return { ...candidate, score: Math.max(direct, reversed), distance };
      })
      .filter((candidate) => candidate.score >= 1.65 && candidate.distance <= EVENT_MATCH_WINDOW_MS)
      .sort((a, b) => b.score - a.score || a.distance - b.distance)[0] ?? null
  );
}

async function historicalSnapshotForMatch(
  match: Match,
  candidate: MatchedGammaEvent,
  decisionAt: string
): Promise<Omit<MarketSnapshot, "id"> | null> {
  const prices = await Promise.all([
    historicalOutcomePrice(candidate, "home", decisionAt),
    historicalOutcomePrice(candidate, "draw", decisionAt),
    historicalOutcomePrice(candidate, "away", decisionAt)
  ]);
  if (prices.some((price) => !price)) return null;
  const [home, draw, away] = prices as PricePoint[];
  const sum = home.p + draw.p + away.p;
  if (sum <= 0) return null;

  return {
    matchId: match.id,
    pHome: round(home.p / sum, 4),
    pDraw: round(draw.p / sum, 4),
    pAway: round(away.p / sum, 4),
    totals: [],
    spreads: [],
    volume: numberOrNull(candidate.event.volume),
    liquidity: numberOrNull(candidate.event.liquidity),
    source: "polymarket",
    fetchedAt: new Date(Math.max(home.t, draw.t, away.t) * 1000).toISOString()
  };
}

async function historicalOutcomePrice(candidate: MatchedGammaEvent, outcome: Outcome, decisionAt: string): Promise<PricePoint | null> {
  const market = findMarketForOutcome(candidate.event, outcome, candidate.homeTeam, candidate.awayTeam);
  const tokenId = market ? yesTokenId(market) : null;
  if (!tokenId) return null;

  const decisionTs = Math.floor(new Date(decisionAt).getTime() / 1000);
  const startTs = decisionTs - 14 * 86400;
  const url = `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}&startTs=${startTs}&endTs=${decisionTs}&interval=max&fidelity=${HISTORY_FIDELITY_MINUTES}`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`CLOB ${response.status}: ${await response.text()}`);
  const payload = (await response.json()) as { history?: PricePoint[] };
  const points = (payload.history ?? [])
    .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p) && point.t <= decisionTs)
    .sort((a, b) => a.t - b.t);
  return points.at(-1) ?? null;
}

function findMarketForOutcome(event: GammaEvent, outcome: Outcome, homeTeam: string, awayTeam: string): GammaMarket | undefined {
  const markets = event.markets ?? [];
  if (outcome === "draw") {
    return markets.find((market) => /draw/i.test(market.question ?? "") || /-draw$/i.test(market.slug ?? ""));
  }
  const team = outcome === "home" ? homeTeam : awayTeam;
  return markets.find((market) => {
    const question = teamKey(market.question ?? "");
    return teamsMatch(teamFromWinQuestion(question), team) || question.includes(`${teamKey(team)} win`);
  });
}

function teamFromWinQuestion(questionKey: string): string {
  const match = questionKey.match(/^will (.+?) win(?: on| against|$)/);
  return match?.[1] ?? "";
}

function yesTokenId(market: GammaMarket): string | null {
  const outcomes = parseArray(market.outcomes);
  const tokenIds = parseArray(market.clobTokenIds);
  const yesIndex = outcomes.findIndex((outcome) => /^yes$/i.test(outcome));
  return yesIndex >= 0 ? tokenIds[yesIndex] ?? null : null;
}

function decisionTime(match: Match, polymarketKickoffUtc: string, leadSeconds: number): string {
  const matchTime = new Date(match.kickoffUtc).getTime();
  const marketTime = new Date(polymarketKickoffUtc).getTime();
  return new Date(Math.min(matchTime, marketTime) - leadSeconds * 1000).toISOString();
}

function duplicateHistoricalSnapshot(store: Store, matchId: string, snapshot: Omit<MarketSnapshot, "id">): boolean {
  return store.marketHistory(matchId, 500).some((existing) => {
    const sameTime = Math.abs(new Date(existing.fetchedAt).getTime() - new Date(snapshot.fetchedAt).getTime()) <= 60_000;
    const samePrices =
      Math.abs(existing.pHome - snapshot.pHome) < 0.0001 &&
      Math.abs(existing.pDraw - snapshot.pDraw) < 0.0001 &&
      Math.abs(existing.pAway - snapshot.pAway) < 0.0001;
    return sameTime && samePrices;
  });
}

function parseArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clean(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}
