import { config } from "../config.js";
import type { Recommendation } from "../../shared/types.js";

export async function sendTelegram(text: string): Promise<boolean> {
  if (!config.telegramBotToken || !config.telegramChatId) return false;
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: config.telegramChatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  if (!response.ok) {
    throw new Error(`Telegram ${response.status}: ${await response.text()}`);
  }
  return true;
}

export async function sendNtfy(text: string, title = "MPP Edge Finder"): Promise<boolean> {
  if (!config.ntfyTopic) return false;
  const baseUrl = config.ntfyServerUrl.replace(/\/+$/, "");
  const topic = encodeURIComponent(config.ntfyTopic);
  const response = await fetch(`${baseUrl}/${topic}`, {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
      title,
      priority: "high",
      tags: "soccer,alarm",
      click: config.publicBaseUrl
    },
    body: text
  });
  if (!response.ok) {
    throw new Error(`ntfy ${response.status}: ${await response.text()}`);
  }
  return true;
}

export function formatRecommendationMessage(rec: Recommendation): string {
  const lines = formatRecommendationPlainLines(rec);
  return [
    `⚽ <b>${escapeHtml(rec.match.homeTeam)} - ${escapeHtml(rec.match.awayTeam)}</b>`,
    lines[1],
    `À jouer: <b>${escapeHtml(rec.play.instruction)}</b>`,
    ...lines.slice(3)
  ].join("\n");
}

export function formatRecommendationPlainMessage(rec: Recommendation): string {
  return formatRecommendationPlainLines(rec).join("\n");
}

function formatRecommendationPlainLines(rec: Recommendation): string[] {
  const kickoff = new Date(rec.match.kickoffUtc).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  const mpp = rec.mpp ? `${rec.mpp.pointsHome} / ${rec.mpp.pointsDraw} / ${rec.mpp.pointsAway}` : "n/a";
  const poly = rec.market
    ? `${(rec.market.pHome * 100).toFixed(0)}% / ${(rec.market.pDraw * 100).toFixed(0)}% / ${(rec.market.pAway * 100).toFixed(0)}%`
    : "n/a";
  return [
    `⚽ ${rec.match.homeTeam} - ${rec.match.awayTeam}`,
    `Coup d'envoi: ${kickoff}`,
    `À jouer: ${rec.play.instruction}`,
    `Objectif: ${rec.strategyScore.toFixed(1)} (${rec.strategy}) | EV ${rec.totalEv.toFixed(1)} | edge EV ${signed(rec.evEdge)} | confiance ${rec.confidence}`,
    `MPP: ${mpp}`,
    `Polymarket: ${poly}`,
    `Foule: leverage ${rec.leverage.toFixed(1)} | edge foule ${signed((rec.crowdEdge * 100), 1)} pts`,
    `X2: ${rec.x2Candidate ? "OUI, meilleur spot actuel" : rec.x2Rank ? `non, rang #${rec.x2Rank}` : "non"}`
  ];
}

function signed(value: number, digits = 1): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[char] ?? char;
  });
}
