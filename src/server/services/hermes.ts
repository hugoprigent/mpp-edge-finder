import { Store } from "../store.js";
import { buildRecommendations } from "./recommender.js";
import { formatRecommendationMessage, sendTelegram } from "./notifications.js";

export function getHermesManifest(baseUrl: string) {
  return {
    name: "mpp-edge-finder",
    description: "Assistant MPP: recommandations de scores, état système et briefing notification.",
    safety: {
      canPlaceBets: false,
      canModifyMpp: false,
      paidApisRequired: false
    },
    tools: [
      {
        name: "get_next_recommendations",
        method: "GET",
        url: `${baseUrl}/api/hermes/tools/get_next_recommendations?limit=8`,
        params: { limit: "optional number, default 8" },
        description: "Retourne les prochaines recommandations classées par horaire et exploitabilité."
      },
      {
        name: "get_system_health",
        method: "GET",
        url: `${baseUrl}/api/hermes/tools/get_system_health`,
        params: {},
        description: "Retourne l'état MPP, Polymarket, notifications, scraper VPS et les problèmes bloquants."
      },
      {
        name: "get_match_recommendation",
        method: "GET",
        url: `${baseUrl}/api/hermes/tools/get_match_recommendation?matchId=...`,
        params: { matchId: "required string" },
        description: "Retourne la recommandation détaillée pour un match précis."
      },
      {
        name: "send_manual_briefing",
        method: "POST",
        url: `${baseUrl}/api/hermes/tools/send_manual_briefing`,
        params: {},
        description: "Envoie un briefing Telegram si Telegram est configuré, sinon retourne seulement le texte."
      }
    ],
    operatorPolicy: [
      "Ne jamais écrire automatiquement de prono dans MPP.",
      "Alerter si MPP ou Polymarket n'a pas été synchronisé récemment.",
      "Toujours présenter la consigne play.instruction, EV, edge, score exact et X2 quand disponibles."
    ]
  };
}

export function getHermesRecommendations(store: Store, limit = 8) {
  return buildRecommendations({
    matches: store.getMatches(),
    mppByMatch: store.latestMppSnapshots(),
    marketByMatch: store.latestMarketSnapshots()
  }).slice(0, limit);
}

export function getHermesHealth(store: Store) {
  const status = store.status();
  const issues: string[] = [];
  if (!status.lastMppSync) issues.push("Aucun import MPP encore disponible.");
  if (status.mppAutoScrape && status.lastMppScrapeError) issues.push(`Scraper MPP automatique en erreur: ${status.lastMppScrapeError}`);
  if (!status.lastPolymarketSync) issues.push("Aucune sync Polymarket encore disponible.");
  if (!status.telegramConfigured && !status.ntfyConfigured) issues.push("Aucun canal VPS configuré; active Telegram ou ntfy pour les notifications hors navigateur.");
  return { ...status, ok: issues.length === 0, issues };
}

export async function sendManualBriefing(store: Store): Promise<{ sent: boolean; text: string }> {
  const recs = getHermesRecommendations(store, 5).filter((rec) => rec.outcome !== "needs-data");
  const text =
    recs.length === 0
      ? "MPP Edge Finder: aucune recommandation exploitable pour le moment."
      : recs.map(formatRecommendationMessage).join("\n\n---\n\n");
  const sent = await sendTelegram(text);
  return { sent, text };
}
