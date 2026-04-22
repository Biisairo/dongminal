#!/bin/bash
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && source .env && set +a
PORT="${PORT:-58146}"
if lsof -ti :$PORT >/dev/null 2>&1; then
  lsof -ti :$PORT | xargs kill 2>/dev/null
  sleep 1
  if lsof -ti :$PORT >/dev/null 2>&1; then
    echo "❌ Failed to stop"
    exit 1
  fi
  echo "✅ Stopped"
else
  echo "Not running"
fi
