import fs from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { config } from "./config.js";
import { Store } from "./store.js";
import { buildRecommendations } from "./services/recommender.js";
import { getHermesHealth, getHermesManifest, getHermesRecommendations, sendManualBriefing } from "./services/hermes.js";
import { scrapeMpp, syncPolymarket, importMppText } from "./services/sync.js";
import { formatRecommendationMessage, formatRecommendationPlainMessage, sendNtfy, sendTelegram } from "./services/notifications.js";
import { startSchedulers } from "./services/scheduler.js";

const app = Fastify({ logger: true });
const store = new Store();
const sseClients = new Set<NodeJS.WritableStream>();

await app.register(cors, { origin: true });

const clientDist = path.resolve(process.cwd(), "dist/client");
if (fs.existsSync(clientDist)) {
  await app.register(fastifyStatic, {
    root: clientDist,
    prefix: "/"
  });
}

function latestData() {
  return {
    matches: store.getMatches(),
    mppByMatch: store.latestMppSnapshots(),
    marketByMatch: store.latestMarketSnapshots()
  };
}

function recommendations(windowHours?: number) {
  return buildRecommendations(latestData(), windowHours ?? 96);
}

function broadcast(event: string, payload: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) client.write(frame);
}

app.get("/api/status", async () => store.status());

app.get("/api/healthz", async () => {
  const status = store.status();
  return {
    ok: true,
    now: status.now,
    db: "ok",
    matches: status.matches,
    mppSnapshots: status.mppSnapshots,
    marketSnapshots: status.marketSnapshots
  };
});

app.get("/api/matches", async () => ({
  matches: store.getMatches(),
  mppSnapshots: store.latestMppSnapshots(),
  marketSnapshots: store.latestMarketSnapshots()
}));

app.get<{ Params: { matchId: string }; Querystring: { limit?: string } }>("/api/matches/:matchId/history", async (request, reply) => {
  const match = store.getMatch(request.params.matchId);
  if (!match) {
    reply.code(404);
    return { error: "matchId introuvable" };
  }
  const limit = Number(request.query.limit);
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(120, limit)) : 60;
  return {
    match,
    mppHistory: store.mppHistory(match.id, Math.min(30, safeLimit)),
    marketHistory: store.marketHistory(match.id, safeLimit)
  };
});

app.get<{ Querystring: { window?: string } }>("/api/recommendations", async (request) => {
  const windowHours = Number(request.query.window);
  return { recommendations: recommendations(Number.isFinite(windowHours) ? windowHours : 96) };
});

app.post("/api/sync/polymarket/run", async () => {
  const result = await syncPolymarket(store);
  broadcast("sync", result);
  return result;
});

app.post<{ Body: { text?: string } }>("/api/import/mpp-text", async (request) => {
  const text = request.body?.text ?? "";
  const result = await importMppText(store, text, "dom");
  broadcast("sync", result);
  return result;
});

app.post("/api/scrape/mpp/run", async () => {
  const result = await scrapeMpp(store);
  broadcast("sync", result);
  return result;
});

app.post<{ Body: { matchId?: string } }>("/api/notifications/test", async (request) => {
  const rec = recommendations().find((item) => item.match.id === request.body?.matchId) ?? recommendations().find((item) => item.outcome !== "needs-data");
  if (!rec) return { ok: false, message: "Aucune recommandation disponible." };
  const text = formatRecommendationMessage(rec);
  const telegram = await sendTelegram(text);
  const ntfy = await sendNtfy(formatRecommendationPlainMessage(rec), `${rec.match.homeTeam} - ${rec.match.awayTeam}`);
  return { ok: true, sent: telegram || ntfy, channels: { telegram, ntfy }, text };
});

app.get("/api/events", async (_request, reply) => {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  reply.raw.write(`event: status\ndata: ${JSON.stringify(store.status())}\n\n`);
  sseClients.add(reply.raw);
  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 25_000);
  reply.raw.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(reply.raw);
  });
});

app.get("/api/hermes/tools/get_next_recommendations", async (request) => {
  const query = request.query as { limit?: string };
  return { recommendations: getHermesRecommendations(store, Number(query.limit) || 8) };
});

app.get("/api/hermes/manifest", async (request) => getHermesManifest(requestOrigin(request)));

app.get("/api/hermes/tools/get_system_health", async () => getHermesHealth(store));

app.get("/api/hermes/tools/get_match_recommendation", async (request) => {
  const query = request.query as { matchId?: string };
  const rec = recommendations().find((item) => item.match.id === query.matchId);
  return rec ? { recommendation: rec } : { error: "matchId introuvable" };
});

app.post("/api/hermes/tools/send_manual_briefing", async () => sendManualBriefing(store));

app.get("/api/bookmarklet", async (request) => {
  const origin = requestOrigin(request);
  const importUrl = `${origin}/api/import/mpp-text`;

  return {
    bookmarklet: buildMppBookmarklet("copy"),
    importBookmarklet: buildMppBookmarklet("post", importUrl)
  };
});

app.setNotFoundHandler(async (request, reply) => {
  if (request.raw.url?.startsWith("/api")) {
    reply.code(404);
    return { error: "Not found" };
  }
  const indexPath = path.join(clientDist, "index.html");
  if (fs.existsSync(indexPath)) return reply.type("text/html").send(fs.readFileSync(indexPath, "utf8"));
  reply.code(404);
  return "Client non buildé. Lance npm run dev:client en développement.";
});

startSchedulers(store, broadcast);

void syncPolymarket(store)
  .then((result) => broadcast("sync", result))
  .catch((error) => app.log.warn({ error }, "Initial Polymarket sync failed"));

await app.listen({ port: config.port, host: config.host });

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function requestOrigin(request: { headers: Record<string, string | string[] | undefined> }): string {
  const forwardedProto = headerValue(request.headers["x-forwarded-proto"])?.split(",")[0]?.trim();
  const forwardedHost = headerValue(request.headers["x-forwarded-host"]);
  const host = forwardedHost ?? headerValue(request.headers.host) ?? `${config.host}:${config.port}`;
  return `${forwardedProto ?? "http"}://${host}`;
}

function buildMppBookmarklet(mode: "copy" | "post", importUrl?: string): string {
  const postBlock =
    mode === "post" && importUrl
      ? `try{const r=await fetch(${JSON.stringify(importUrl)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:JSON.stringify(o)})});const j=await r.json();alert(j.message||'Snapshot MPP importé')}catch(e){await navigator.clipboard.writeText(JSON.stringify(o,null,2));alert('Import direct impossible, snapshot copié')}`
      : `await navigator.clipboard.writeText(JSON.stringify(o,null,2));alert('Snapshot MPP copié')`;

  return `javascript:(async()=>{const c=s=>(s||'').replace(/\\s+/g,' ').trim(),o=[];function w(n){if(!n||o.length>1200)return;if(n.nodeType===3){const t=c(n.nodeValue);if(t)o.push({type:'text',value:t});return}if(n.nodeType!==1)return;const e=n;if(e.tagName==='INPUT'||e.tagName==='TEXTAREA'){o.push({type:'input',value:e.value||''});return}for(const x of Array.from(e.childNodes||[]))w(x)}w(document.body);${postBlock}})()`;
}
