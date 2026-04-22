#!/bin/bash
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && source .env && set +a
PORT="${PORT:-58146}"
URL="http://localhost:${PORT}/"

if curl -sf --max-time 3 "$URL" > /dev/null 2>&1; then
  echo "OK: dongminal running on :${PORT}"
  exit 0
else
  echo "FAIL: not responding on :${PORT}"
  exit 1
fi
