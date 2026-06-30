import { config } from "../config.js";
import { clamp, nowIso, round } from "../utils.js";
import { teamKey } from "../../shared/teamAliases.js";
import type { SpreadMarket, TotalMarket } from "../../shared/types.js";

export type ParsedPolymarketEvent = {
  kickoffUtc: string;
  homeTeam: string;
  awayTeam: string;
  slug: string;
  volume: number | null;
  liquidity: number | null;
  pHome: number;
  pDraw: number;
  pAway: number;
  totals: TotalMarket[];
  spreads: SpreadMarket[];
  fetchedAt: string;
};

type PolyEvent = {
  title?: string;
  slug?: string;
  startDate?: string;
  volume?: number;
  liquidity?: number | null;
  markets?: PolyMarket[];
};

type PolyMarket = {
  question?: string;
  marketType?: string;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  prices?: string | string[];
};

export async function fetchPolymarketSports(): Promise<ParsedPolymarketEvent[]> {
  const url = `https://gateway.polymarket.us/v2/leagues/${encodeURIComponent(config.polymarketLeagueSlug)}/events?limit=200&type=sport`;
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Polymarket ${response.status}: ${await response.text()}`);
  }
  const payload = (await response.json()) as { events?: PolyEvent[] };
  const fetchedAt = nowIso();
  return (payload.events ?? []).flatMap((event) => parsePolymarketEvent(event, fetchedAt));
}

export function parsePolymarketEvent(event: PolyEvent, fetchedAt = nowIso()): ParsedPolymarketEvent[] {
  const title = event.title ?? "";
  const teams = title.split(/\s+vs\.?\s+/i).map((part) => part.trim());
  if (teams.length !== 2 || !event.startDate) return [];

  const homeTeam = teams[0];
  const awayTeam = teams[1];
  const markets = event.markets ?? [];
  const outcomeMarkets = markets.filter((market) => market.marketType === "drawable_outcome");

  const pHome = yesProbability(outcomeMarkets.find((market) => isWinMarket(market, homeTeam, awayTeam)));
  const pDraw = yesProbability(outcomeMarkets.find((market) => /end in a draw|draw/i.test(market.question ?? "")));
  const pAway = yesProbability(outcomeMarkets.find((market) => isWinMarket(market, awayTeam, homeTeam)));

  if (pHome == null || pDraw == null || pAway == null) return [];
  const sum = pHome + pDraw + pAway;
  if (sum <= 0) return [];

  return [
    {
      kickoffUtc: new Date(event.startDate).toISOString(),
      homeTeam,
      awayTeam,
      slug: event.slug ?? title,
      volume: numberOrNull(event.volume),
      liquidity: numberOrNull(event.liquidity),
      pHome: round(pHome / sum, 4),
      pDraw: round(pDraw / sum, 4),
      pAway: round(pAway / sum, 4),
      totals: parseTotals(markets),
      spreads: parseSpreads(markets, homeTeam, awayTeam),
      fetchedAt
    }
  ];
}

function yesProbability(market: PolyMarket | undefined): number | null {
  if (!market) return null;
  const outcomes = parseArray(market.outcomes);
  const prices = parseArray(market.outcomePrices ?? market.prices).map(Number);
  const yesIndex = outcomes.findIndex((outcome) => /^yes$/i.test(outcome));
  if (yesIndex < 0 || !Number.isFinite(prices[yesIndex])) return null;
  return clamp(prices[yesIndex], 0, 1);
}

function isWinMarket(market: PolyMarket, team: string, opponent: string): boolean {
  const question = teamKey(market.question ?? "");
  return question.includes(`${teamKey(team)} win`) && question.includes(teamKey(opponent));
}

function parseTotals(markets: PolyMarket[]): TotalMarket[] {
  const byThreshold = new Map<number, TotalMarket>();
  for (const market of markets.filter((item) => item.marketType === "totals")) {
    const question = market.question ?? "";
    const threshold = Number(question.match(/more than ([0-9.]+)/i)?.[1]);
    if (!Number.isFinite(threshold)) continue;
    const outcomes = parseArray(market.outcomes);
    const prices = parseArray(market.outcomePrices ?? market.prices).map(Number);
    const overIndex = outcomes.findIndex((outcome) => /^over$/i.test(outcome));
    const underIndex = outcomes.findIndex((outcome) => /^under$/i.test(outcome));
    if (overIndex < 0 || underIndex < 0) continue;
    const pOver = prices[overIndex];
    const pUnder = prices[underIndex];
    if (!Number.isFinite(pOver) || !Number.isFinite(pUnder)) continue;
    if (!byThreshold.has(threshold) || pOver + pUnder > 0.1) {
      byThreshold.set(threshold, {
        threshold,
        pOver: round(clamp(pOver, 0, 1), 4),
        pUnder: round(clamp(pUnder, 0, 1), 4)
      });
    }
  }
  return [...byThreshold.values()].sort((a, b) => a.threshold - b.threshold);
}

function parseSpreads(markets: PolyMarket[], homeTeam: string, awayTeam: string): SpreadMarket[] {
  const spreads: SpreadMarket[] = [];
  for (const market of markets.filter((item) => item.marketType === "spreads")) {
    const question = market.question ?? "";
    const outcomes = parseArray(market.outcomes);
    const prices = parseArray(market.outcomePrices ?? market.prices).map(Number);
    const coverTeam = teamKey(question).includes(teamKey(homeTeam)) ? "home" : teamKey(question).includes(teamKey(awayTeam)) ? "away" : "unknown";
    for (let i = 0; i < outcomes.length; i += 1) {
      const line = Number(outcomes[i]);
      const pCover = prices[i];
      if (Number.isFinite(line) && Number.isFinite(pCover)) {
        spreads.push({ team: coverTeam, line, pCover: round(clamp(pCover, 0, 1), 4) });
      }
    }
  }
  return spreads.slice(0, 20);
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
