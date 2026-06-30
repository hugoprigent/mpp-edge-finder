#!/usr/bin/env bash
set -euo pipefail

: "${VPS_HOST:?Définis VPS_HOST, ex: VPS_HOST=1.2.3.4}"

VPS_USER="${VPS_USER:-root}"
VPS_PATH="${VPS_PATH:-/opt/mpp-edge-finder}"
REMOTE="${VPS_USER}@${VPS_HOST}"

echo "Déploiement MPP Edge Finder vers ${REMOTE}:${VPS_PATH}"

ssh "${REMOTE}" "mkdir -p '${VPS_PATH}'"
rsync -az --delete \
  --exclude ".git/" \
  --exclude ".env" \
  --exclude "node_modules/" \
  --exclude "dist/" \
  --exclude "data/" \
  ./ "${REMOTE}:${VPS_PATH}/"

ssh "${REMOTE}" "cd '${VPS_PATH}' && test -f .env || cp .env.example .env"
ssh "${REMOTE}" "cd '${VPS_PATH}' && docker compose up -d --build"
ssh "${REMOTE}" "cd '${VPS_PATH}' && BASE_URL=http://127.0.0.1:8787 ./scripts/vps-smoke-test.sh"

echo "Déploiement terminé. Pense à régler PUBLIC_BASE_URL dans ${VPS_PATH}/.env si tu exposes un domaine."
