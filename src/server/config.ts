import { randomBytes } from "node:crypto";
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

function strategyEnv(name: string): "ev" | "chase" {
  return process.env[name]?.toLowerCase() === "ev" ? "ev" : "chase";
}

function listEnv(name: string, fallback: string): string[] {
  const value = process.env[name] || fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  port: numberEnv("PORT", 8787),
  host: process.env.HOST || "0.0.0.0",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:8787",
  dataDir: path.resolve(root, process.env.DATA_DIR || "./data"),
  dashboardPinCodes: listEnv("DASHBOARD_PIN_CODES", "1706,0000"),
  dashboardSessionSecret: process.env.DASHBOARD_SESSION_SECRET || randomBytes(32).toString("hex"),
  mppChampionshipId: numberEnv("MPP_CHAMPIONSHIP_ID", 8),
  mppYear: numberEnv("MPP_YEAR", 2026),
  mppLocalUtcOffsetHours: numberEnv("MPP_LOCAL_UTC_OFFSET_HOURS", 0),
  mppProfileDir: path.resolve(root, process.env.MPP_PROFILE_DIR || "./data/mpp-chrome-profile"),
  mppHeadless: boolEnv("MPP_HEADLESS", false),
  mppAutoScrape: boolEnv("MPP_AUTO_SCRAPE", true),
  mppPollMinutes: numberEnv("MPP_POLL_MINUTES", 10),
  mppFastPollMinutes: numberEnv("MPP_FAST_POLL_MINUTES", 2),
  mppAutoPlay: boolEnv("MPP_AUTO_PLAY", false),
  mppAutoPlayDryRun: boolEnv("MPP_AUTO_PLAY_DRY_RUN", true),
  mppAutoPlayLeadSeconds: numberEnv("MPP_AUTO_PLAY_LEAD_SECONDS", 600),
  mppAutoPlayWindowSeconds: numberEnv("MPP_AUTO_PLAY_WINDOW_SECONDS", 180),
  mppHourlyAutoPlay: boolEnv("MPP_HOURLY_AUTO_PLAY", false),
  mppHourlyAutoPlayDryRun: boolEnv("MPP_HOURLY_AUTO_PLAY_DRY_RUN", boolEnv("MPP_AUTO_PLAY_DRY_RUN", true)),
  mppHourlyAutoPlayIntervalMinutes: numberEnv("MPP_HOURLY_AUTO_PLAY_INTERVAL_MINUTES", 60),
  mppHourlyAutoPlayHorizonHours: numberEnv("MPP_HOURLY_AUTO_PLAY_HORIZON_HOURS", 168),
  mppHourlyAutoPlayWriteDelayMs: numberEnv("MPP_HOURLY_AUTO_PLAY_WRITE_DELAY_MS", 2500),
  mppStrategyMode: strategyEnv("MPP_STRATEGY_MODE"),
  mppChaseLeverageWeight: numberEnv("MPP_CHASE_LEVERAGE_WEIGHT", 0.35),
  mppChasePositiveCrowdEdgeWeight: numberEnv("MPP_CHASE_POSITIVE_CROWD_EDGE_WEIGHT", 0.25),
  mppChaseNegativeCrowdEdgeWeight: numberEnv("MPP_CHASE_NEGATIVE_CROWD_EDGE_WEIGHT", 0.18),
  mppChaseLotteryPenaltyWeight: numberEnv("MPP_CHASE_LOTTERY_PENALTY_WEIGHT", 0.8),
  mppChaseMinUsefulProbability: numberEnv("MPP_CHASE_MIN_USEFUL_PROBABILITY", 0.08),
  mppChaseScoreBonusWeight: numberEnv("MPP_CHASE_SCORE_BONUS_WEIGHT", 0.25),
  polymarketLeagueSlug: process.env.POLYMARKET_LEAGUE_SLUG || "fwc",
  polymarketPollMinutes: numberEnv("POLYMARKET_POLL_MINUTES", 5),
  notificationLeadMinutes: numberEnv("NOTIFICATION_LEAD_MINUTES", 10),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
  ntfyServerUrl: process.env.NTFY_SERVER_URL || "https://ntfy.sh",
  ntfyTopic: process.env.NTFY_TOPIC || ""
};
