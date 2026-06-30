import { nowIso } from "../utils.js";
import { Store } from "../store.js";
import { fetchPolymarketSports } from "./polymarket.js";
import { parseMppImport, type ParsedMppMatch } from "./mppTextParser.js";
import { scrapeMppWithPlaywright } from "./mppScraper.js";
import type { SyncResult } from "../../shared/types.js";

export async function syncPolymarket(store: Store): Promise<SyncResult> {
  const events = await fetchPolymarketSports();
  let matchedMarkets = 0;
  for (const event of events) {
    const match = store.upsertMatch({
      kickoffUtc: event.kickoffUtc,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      source: "polymarket",
      polymarketSlug: event.slug
    });
    store.addMarketSnapshot({
      matchId: match.id,
      pHome: event.pHome,
      pDraw: event.pDraw,
      pAway: event.pAway,
      totals: event.totals,
      spreads: event.spreads,
      volume: event.volume,
      liquidity: event.liquidity,
      source: "polymarket",
      fetchedAt: event.fetchedAt
    });
    matchedMarkets += 1;
  }
  return {
    ok: true,
    message: `${matchedMarkets} marchés Polymarket synchronisés.`,
    matchedMarkets
  };
}

export async function importMppText(store: Store, text: string, rawSource: "dom" | "playwright" | "api" = "dom"): Promise<SyncResult> {
  const parsed = parseMppImport(text);
  return importParsedMpp(store, parsed, rawSource);
}

export async function scrapeMpp(store: Store): Promise<SyncResult> {
  const parsed = await scrapeMppWithPlaywright();
  return importParsedMpp(store, parsed, "playwright");
}

export function importParsedMpp(store: Store, parsed: ParsedMppMatch[], rawSource: "dom" | "playwright" | "api"): SyncResult {
  const scrapedAt = nowIso();
  for (const item of parsed) {
    const match = store.upsertMatch({
      kickoffUtc: item.kickoffUtc,
      homeTeam: item.homeTeam,
      awayTeam: item.awayTeam,
      phase: item.phase,
      scope: item.scope,
      source: "mpp",
      mppKey: item.mppKey
    });
    store.addMppSnapshot({
      matchId: match.id,
      pointsHome: item.pointsHome,
      pointsDraw: item.pointsDraw,
      pointsAway: item.pointsAway,
      crowdHomePct: item.crowdHomePct,
      crowdDrawPct: item.crowdDrawPct,
      crowdAwayPct: item.crowdAwayPct,
      currentHomeScore: item.currentHomeScore,
      currentAwayScore: item.currentAwayScore,
      rawSource,
      scrapedAt
    });
  }
  return {
    ok: parsed.length > 0,
    message: parsed.length > 0 ? `${parsed.length} matchs MPP lus.` : "Aucun match MPP reconnu pendant la lecture.",
    importedMatches: parsed.length
  };
}
