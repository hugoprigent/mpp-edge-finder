import { config } from "../config.js";
import { Store } from "../store.js";
import { buildRecommendations } from "./recommender.js";
import { formatRecommendationMessage, formatRecommendationPlainMessage, sendNtfy, sendTelegram } from "./notifications.js";
import { scrapeMpp, syncPolymarket } from "./sync.js";
import { applyMppRecommendation, applyMppRecommendations, type MppAutoPlayResult } from "./mppAutoPlayer.js";
import type { Match, Recommendation } from "../../shared/types.js";

const NEAR_KICKOFF_WINDOW_MS = 2 * 36e5;
const POLYMARKET_FAST_POLL_MS = 60_000;
const FIRST_MPP_SCRAPE_DELAY_MS = 15_000;
const FIRST_HOURLY_AUTO_PLAY_DELAY_MS = 60_000;
const NOTIFICATION_TOLERANCE_MS = 60_000;
const AUTO_PLAY_TICK_MS = 20_000;

let autoPlayRunning = false;
let availableAutoPlayRunning = false;
let hourlyAutoPlayRunning = false;

export function startSchedulers(store: Store, broadcast: (event: string, payload: unknown) => void): void {
  schedulePolymarketSync(store, broadcast);
  scheduleMppScrape(store, broadcast, FIRST_MPP_SCRAPE_DELAY_MS);
  scheduleHourlyMppAutoPlay(store, broadcast, FIRST_HOURLY_AUTO_PLAY_DELAY_MS);

  setInterval(() => {
    void notifyUpcomingMatches(store, broadcast).catch((error) => broadcast("error", { message: String(error?.message ?? error) }));
  }, 60_000).unref();

  setInterval(() => {
    void autoPlayUpcomingMatches(store, broadcast).catch((error) => broadcast("error", { source: "mpp-autoplay", message: String(error?.message ?? error) }));
  }, AUTO_PLAY_TICK_MS).unref();
}

function schedulePolymarketSync(store: Store, broadcast: (event: string, payload: unknown) => void): void {
  setTimeout(() => {
    void syncPolymarket(store)
      .then((result) => {
        broadcast("sync", result);
        triggerAvailableMppAutoPlay(store, broadcast, "polymarket");
      })
      .catch((error) => broadcast("error", { message: String(error?.message ?? error) }))
      .finally(() => schedulePolymarketSync(store, broadcast));
  }, nextPolymarketPollMs(store.getMatches())).unref();
}

function scheduleMppScrape(store: Store, broadcast: (event: string, payload: unknown) => void, delayMs = nextMppPollMs(store.getMatches())): void {
  if (!config.mppAutoScrape) return;
  setTimeout(() => {
    store.setSetting("lastMppScrapeAttempt", new Date().toISOString());
    void scrapeMpp(store)
      .then((result) => {
        store.setSetting("lastMppScrapeError", "");
        broadcast("sync", result);
        triggerAvailableMppAutoPlay(store, broadcast, "mpp");
      })
      .catch((error) => {
        const message = readableScrapeError(error);
        store.setSetting("lastMppScrapeError", message);
        broadcast("error", { source: "mpp", message });
      })
      .finally(() => scheduleMppScrape(store, broadcast));
  }, delayMs).unref();
}

export function triggerAvailableMppAutoPlay(store: Store, broadcast: (event: string, payload: unknown) => void, source = "sync"): void {
  if (!config.mppAvailableAutoPlay) return;
  void autoPlayAvailableMatches(store, broadcast, source).catch((error) =>
    broadcast("error", { source: "mpp-available-autoplay", trigger: source, message: String(error?.message ?? error) })
  );
}

function scheduleHourlyMppAutoPlay(store: Store, broadcast: (event: string, payload: unknown) => void, delayMs = nextHourlyAutoPlayMs()): void {
  if (!config.mppHourlyAutoPlay) return;
  setTimeout(() => {
    void autoPlayHourlyMatches(store, broadcast)
      .catch((error) => broadcast("error", { source: "mpp-hourly-autoplay", message: String(error?.message ?? error) }))
      .finally(() => scheduleHourlyMppAutoPlay(store, broadcast));
  }, delayMs).unref();
}

function readableScrapeError(error: unknown): string {
  const message = String(error instanceof Error ? error.message : error);
  if (message.includes("Executable doesn't exist") || message.includes("playwright install")) {
    return "Chromium Playwright absent. Lance `npx playwright install chromium` en local; le Dockerfile le fait automatiquement sur VPS.";
  }
  return message.split("\n")[0]?.slice(0, 500) || "Erreur inconnue du scraper MPP.";
}

export async function notifyUpcomingMatches(store: Store, broadcast: (event: string, payload: unknown) => void): Promise<void> {
  const recs = buildRecommendations({
    matches: store.getMatches(),
    mppByMatch: store.latestMppSnapshots(),
    marketByMatch: store.latestMarketSnapshots()
  });

  const now = Date.now();
  const leadMs = config.notificationLeadMinutes * 60_000;
  for (const rec of recs) {
    if (rec.outcome === "needs-data") continue;
    const delta = new Date(rec.match.kickoffUtc).getTime() - now;
    const inWindow = Math.abs(delta - leadMs) <= NOTIFICATION_TOLERANCE_MS;
    if (!inWindow) continue;

    const appType = `app-${config.notificationLeadMinutes}min`;
    if (!store.alreadyNotified(rec.match.id, appType)) {
      store.recordNotification(rec.match.id, appType);
      broadcast("notification", notificationPayload(rec, appType, false));
    }

    const telegramType = `telegram-${config.notificationLeadMinutes}min`;
    if (config.telegramBotToken && config.telegramChatId && !store.alreadyNotified(rec.match.id, telegramType)) {
      await sendTelegram(formatRecommendationMessage(rec));
      store.recordNotification(rec.match.id, telegramType);
      broadcast("notification", notificationPayload(rec, telegramType, true));
    }

    const ntfyType = `ntfy-${config.notificationLeadMinutes}min`;
    if (!config.ntfyTopic || store.alreadyNotified(rec.match.id, ntfyType)) continue;
    await sendNtfy(formatRecommendationPlainMessage(rec), `${rec.match.homeTeam} - ${rec.match.awayTeam}`);
    store.recordNotification(rec.match.id, ntfyType);
    broadcast("notification", notificationPayload(rec, ntfyType, true));
  }
}

export async function autoPlayUpcomingMatches(store: Store, broadcast: (event: string, payload: unknown) => void): Promise<void> {
  if (!config.mppAutoPlay || autoPlayRunning) return;
  const now = Date.now();
  const leadMs = config.mppAutoPlayLeadSeconds * 1000;
  const windowMs = config.mppAutoPlayWindowSeconds * 1000;
  const hasNearCandidate = store.getMatches().some((match) => {
    const delta = new Date(match.kickoffUtc).getTime() - now;
    return delta >= 0 && delta <= leadMs + windowMs + 60_000;
  });
  if (!hasNearCandidate) return;

  autoPlayRunning = true;
  try {
    await Promise.allSettled([syncPolymarket(store), scrapeMpp(store)]);
    const recs = buildRecommendations({
      matches: store.getMatches(),
      mppByMatch: store.latestMppSnapshots(),
      marketByMatch: store.latestMarketSnapshots()
    });

    for (const rec of recs) {
      if (rec.outcome === "needs-data" || !rec.score) continue;
      const delta = new Date(rec.match.kickoffUtc).getTime() - Date.now();
      if (delta < 0 || Math.abs(delta - leadMs) > windowMs) continue;
      const type = `mpp-autoplay-${config.mppAutoPlayLeadSeconds}s`;
      if (store.alreadyNotified(rec.match.id, type)) continue;
      const result = await applyMppRecommendation(rec, config.mppAutoPlayDryRun);
      broadcast("automation", result);
      if (result.ok && !result.dryRun) store.recordNotification(rec.match.id, type);
    }
  } finally {
    autoPlayRunning = false;
  }
}

export async function autoPlayAvailableMatches(store: Store, broadcast: (event: string, payload: unknown) => void, source = "sync"): Promise<void> {
  if (!config.mppAvailableAutoPlay || availableAutoPlayRunning) return;
  availableAutoPlayRunning = true;
  try {
    const recs = buildRecommendations(
      {
        matches: store.getMatches(),
        mppByMatch: store.latestMppSnapshots(),
        marketByMatch: store.latestMarketSnapshots()
      },
      config.mppAvailableAutoPlayHorizonHours
    );
    const candidates = selectAvailableAutoPlayRecommendations(recs);
    if (candidates.length === 0) return;

    const results = await applyMppRecommendations(candidates, config.mppAvailableAutoPlayDryRun, Math.max(0, config.mppAvailableAutoPlayWriteDelayMs));
    for (const result of results) broadcast("automation", result);
    const ok = results.filter((result) => result.ok).length;
    const storedSnapshots = storeAppliedMppSnapshots(store, candidates, results);
    broadcast("automation", {
      ok: ok === results.length,
      dryRun: config.mppAvailableAutoPlayDryRun,
      trigger: source,
      message: `Scores disponibles MPP: ${ok}/${results.length} scores vides traités.`,
      storedSnapshots,
      updatedMatches: results.length
    });
  } finally {
    availableAutoPlayRunning = false;
  }
}

export async function autoPlayHourlyMatches(store: Store, broadcast: (event: string, payload: unknown) => void): Promise<void> {
  if (!config.mppHourlyAutoPlay || hourlyAutoPlayRunning) return;
  hourlyAutoPlayRunning = true;
  try {
    const marketResult = await syncPolymarket(store);
    broadcast("sync", marketResult);

    store.setSetting("lastMppScrapeAttempt", new Date().toISOString());
    let mppResult;
    try {
      mppResult = await scrapeMpp(store);
      store.setSetting("lastMppScrapeError", "");
    } catch (error) {
      const message = readableScrapeError(error);
      store.setSetting("lastMppScrapeError", message);
      throw error;
    }
    broadcast("sync", mppResult);

    const recs = buildRecommendations(
      {
        matches: store.getMatches(),
        mppByMatch: store.latestMppSnapshots(),
        marketByMatch: store.latestMarketSnapshots()
      },
      config.mppHourlyAutoPlayHorizonHours
    );
    const candidates = selectHourlyAutoPlayRecommendations(recs);
    if (candidates.length === 0) {
      broadcast("automation", {
        ok: true,
        dryRun: config.mppHourlyAutoPlayDryRun,
        message: "Mise à jour horaire MPP: aucun score à modifier.",
        recommendations: recs.length
      });
      return;
    }

    const results = await applyMppRecommendations(candidates, config.mppHourlyAutoPlayDryRun, Math.max(0, config.mppHourlyAutoPlayWriteDelayMs));
    for (const result of results) broadcast("automation", result);
    const ok = results.filter((result) => result.ok).length;
    const storedSnapshots = storeAppliedMppSnapshots(store, candidates, results);
    broadcast("automation", {
      ok: ok === results.length,
      dryRun: config.mppHourlyAutoPlayDryRun,
      message: `Mise à jour horaire MPP: ${ok}/${results.length} scores traités.`,
      storedSnapshots,
      updatedMatches: results.length
    });
  } finally {
    hourlyAutoPlayRunning = false;
  }
}

export function selectHourlyAutoPlayRecommendations(recs: Recommendation[], nowMs = Date.now()): Recommendation[] {
  return recs.filter((rec) => {
    if (rec.outcome === "needs-data" || !rec.score || !rec.mpp) return false;
    const kickoffMs = new Date(rec.match.kickoffUtc).getTime();
    if (!Number.isFinite(kickoffMs) || kickoffMs <= nowMs) return false;
    return rec.mpp.currentHomeScore !== rec.score.home || rec.mpp.currentAwayScore !== rec.score.away;
  });
}

export function selectAvailableAutoPlayRecommendations(recs: Recommendation[], nowMs = Date.now()): Recommendation[] {
  return recs.filter((rec) => {
    if (rec.outcome === "needs-data" || !rec.score || !rec.mpp) return false;
    const kickoffMs = new Date(rec.match.kickoffUtc).getTime();
    if (!Number.isFinite(kickoffMs) || kickoffMs <= nowMs) return false;
    return rec.mpp.currentHomeScore == null || rec.mpp.currentAwayScore == null;
  });
}

export function nextHourlyAutoPlayMs(): number {
  return Math.max(1, config.mppHourlyAutoPlayIntervalMinutes) * 60_000;
}

function storeAppliedMppSnapshots(store: Store, recs: Recommendation[], results: MppAutoPlayResult[]): number {
  const recByMatchId = new Map(recs.map((rec) => [rec.match.id, rec]));
  const scrapedAt = new Date().toISOString();
  let stored = 0;
  for (const result of results) {
    const rec = recByMatchId.get(result.matchId);
    if (!rec?.mpp || !rec.score || !result.ok || result.dryRun) continue;
    store.addMppSnapshot({
      matchId: rec.match.id,
      pointsHome: rec.mpp.pointsHome,
      pointsDraw: rec.mpp.pointsDraw,
      pointsAway: rec.mpp.pointsAway,
      crowdHomePct: rec.mpp.crowdHomePct,
      crowdDrawPct: rec.mpp.crowdDrawPct,
      crowdAwayPct: rec.mpp.crowdAwayPct,
      currentHomeScore: rec.score.home,
      currentAwayScore: rec.score.away,
      rawSource: "playwright",
      scrapedAt
    });
    stored += 1;
  }
  return stored;
}

export function nextPolymarketPollMs(matches: Pick<Match, "kickoffUtc">[], nowMs = Date.now()): number {
  const baseMs = Math.max(1, config.polymarketPollMinutes) * 60_000;
  const hasNearKickoff = matches.some((match) => {
    const delta = new Date(match.kickoffUtc).getTime() - nowMs;
    return delta >= -30 * 60_000 && delta <= NEAR_KICKOFF_WINDOW_MS;
  });
  return hasNearKickoff ? Math.min(baseMs, POLYMARKET_FAST_POLL_MS) : baseMs;
}

export function nextMppPollMs(matches: Pick<Match, "kickoffUtc">[], nowMs = Date.now()): number {
  const baseMs = Math.max(1, config.mppPollMinutes) * 60_000;
  const fastMs = Math.max(1, config.mppFastPollMinutes) * 60_000;
  const hasNearKickoff = matches.some((match) => {
    const delta = new Date(match.kickoffUtc).getTime() - nowMs;
    return delta >= -30 * 60_000 && delta <= NEAR_KICKOFF_WINDOW_MS;
  });
  return hasNearKickoff ? Math.min(baseMs, fastMs) : baseMs;
}

function notificationPayload(rec: Recommendation, type: string, telegramSent: boolean) {
  return {
    matchId: rec.match.id,
    type,
    telegramSent,
    title: `${rec.match.homeTeam} - ${rec.match.awayTeam}`,
    body: formatRecommendationMessage(rec).replace(/<[^>]*>/g, "")
  };
}
