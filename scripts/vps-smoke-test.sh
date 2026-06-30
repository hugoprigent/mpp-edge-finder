#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8787}"

echo "MPP Edge Finder smoke test"
echo "Base URL: ${BASE_URL}"

if [[ ! -f .env ]]; then
  echo "WARN: .env absent. Copie .env.example en .env avant un déploiement VPS réel."
fi

mkdir -p data
test -d data

health="$(curl --fail --silent "${BASE_URL}/api/healthz")"
status="$(curl --fail --silent "${BASE_URL}/api/status")"
manifest="$(curl --fail --silent "${BASE_URL}/api/hermes/manifest")"
recommendations="$(curl --fail --silent "${BASE_URL}/api/recommendations?window=168")"

node --input-type=module - "$health" "$status" "$manifest" "$recommendations" <<'NODE'
const [healthRaw, statusRaw, manifestRaw, recommendationsRaw] = process.argv.slice(2);
const health = JSON.parse(healthRaw);
const status = JSON.parse(statusRaw);
const manifest = JSON.parse(manifestRaw);
const recommendations = JSON.parse(recommendationsRaw);

if (health.ok !== true) throw new Error("healthz not ok");
if (manifest.safety?.canPlaceBets !== false) throw new Error("manifest safety missing canPlaceBets=false");
if (!Array.isArray(recommendations.recommendations)) throw new Error("recommendations payload invalid");
const playable = recommendations.recommendations.find((rec) => rec.play?.ready);
if (playable && !playable.play.instruction?.startsWith("Mets ")) {
  throw new Error("play instruction missing precise Mets ... text");
}

console.log(JSON.stringify({
  ok: true,
  matches: status.matches,
  mppSnapshots: status.mppSnapshots,
  marketSnapshots: status.marketSnapshots,
  hermesTools: manifest.tools.length,
  recommendations: recommendations.recommendations.length,
  samplePlay: playable?.play?.instruction ?? null,
  telegramConfigured: status.telegramConfigured,
  ntfyConfigured: status.ntfyConfigured
}, null, 2));
NODE
