#!/usr/bin/env bash
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-99}"
export DISPLAY=":${DISPLAY_NUM}"
export MPP_PROFILE_DIR="${MPP_PROFILE_DIR:-/data/mpp-chrome-profile}"

mkdir -p "${MPP_PROFILE_DIR}"

cleanup() {
  jobs -pr | xargs -r kill
}
trap cleanup EXIT

Xvfb "${DISPLAY}" -screen 0 1440x1000x24 -ac +extension GLX +render -noreset &
fluxbox >/tmp/mpp-fluxbox.log 2>&1 &
x11vnc -display "${DISPLAY}" -forever -shared -nopw -listen 0.0.0.0 -rfbport 5900 >/tmp/mpp-x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 0.0.0.0:6080 localhost:5900 >/tmp/mpp-websockify.log 2>&1 &

echo "noVNC prêt: ouvre http://<IP_DU_VPS>:6080/vnc.html"
echo "Connecte-toi à MPP une fois, attends que les matchs soient visibles, puis arrête ce service."
echo "Profil Chromium persistant: ${MPP_PROFILE_DIR}"

node --input-type=module <<'NODE'
import { chromium } from "playwright";

const profileDir = process.env.MPP_PROFILE_DIR || "/data/mpp-chrome-profile";
const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1440, height: 1000 },
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://mpp.football/", { waitUntil: "domcontentloaded", timeout: 45_000 });

process.on("SIGTERM", async () => {
  await context.close();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await context.close();
  process.exit(0);
});

await new Promise(() => {});
NODE
