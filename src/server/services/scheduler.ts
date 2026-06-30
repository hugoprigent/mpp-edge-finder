import { config } from "../config.js";
import { Store } from "../store.js";
import { buildRecommendations } from "./recommender.js";
import { formatRecommendationMessage, formatRecommendationPlainMessage, sendNtfy, sendTelegram } from "./notifications.js";
import { scrapeMpp, syncPolymarket } from "./sync.js";
import type { Match, Recommendation } from "../../shared/types.js";

const NEAR_KICKOFF_WINDOW_MS = 2 * 36e5;
const POLYMARKET_FAST_POLL_MS = 60_000;
const FIRST_MPP_SCRAPE_DELAY_MS = 15_000;
const NOTIFICATION_TOLERANCE_MS = 60_000;

export function startSchedulers(store: Store, broadcast: (event: string, payload: unknown) => void): void {
  schedulePolymarketSync(store, broadcast);
  scheduleMppScrape(store, broadcast, FIRST_MPP_SCRAPE_DELAY_MS);

  setInterval(() => {
    void notifyUpcomingMatches(store, broadcast).catch((error) => broadcast("error", { message: String(error?.message ?? error) }));
  }, 60_000).unref();
}

function schedulePolymarketSync(store: Store, broadcast: (event: string, payload: unknown) => void): void {
  setTimeout(() => {
    void syncPolymarket(store)
      .then((result) => broadcast("sync", result))
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
      })
      .catch((error) => {
        const message = readableScrapeError(error);
        store.setSetting("lastMppScrapeError", message);
        broadcast("error", { source: "mpp", message });
      })
      .finally(() => scheduleMppScrape(store, broadcast));
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
