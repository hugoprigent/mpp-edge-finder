import path from "node:path";

const root = process.cwd();

function boolEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

export const config = {
  port: numberEnv("PORT", 8787),
  host: process.env.HOST || "0.0.0.0",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:8787",
  dataDir: path.resolve(root, process.env.DATA_DIR || "./data"),
  mppChampionshipId: numberEnv("MPP_CHAMPIONSHIP_ID", 8),
  mppYear: numberEnv("MPP_YEAR", 2026),
  mppLocalUtcOffsetHours: numberEnv("MPP_LOCAL_UTC_OFFSET_HOURS", 2),
  mppProfileDir: path.resolve(root, process.env.MPP_PROFILE_DIR || "./data/mpp-chrome-profile"),
  mppHeadless: boolEnv("MPP_HEADLESS", false),
  mppAutoScrape: boolEnv("MPP_AUTO_SCRAPE", true),
  mppPollMinutes: numberEnv("MPP_POLL_MINUTES", 10),
  mppFastPollMinutes: numberEnv("MPP_FAST_POLL_MINUTES", 2),
  polymarketLeagueSlug: process.env.POLYMARKET_LEAGUE_SLUG || "fwc",
  polymarketPollMinutes: numberEnv("POLYMARKET_POLL_MINUTES", 5),
  notificationLeadMinutes: numberEnv("NOTIFICATION_LEAD_MINUTES", 10),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  ntfyServerUrl: process.env.NTFY_SERVER_URL || "https://ntfy.sh",
  ntfyTopic: process.env.NTFY_TOPIC || ""
};
