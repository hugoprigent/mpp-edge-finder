#!/usr/bin/env bash
set -euo pipefail

if command -v openssl >/dev/null 2>&1; then
  suffix="$(openssl rand -hex 18)"
else
  suffix="$(date +%s)-$RANDOM-$RANDOM-$RANDOM"
fi

echo "mpp-edge-${suffix}"
