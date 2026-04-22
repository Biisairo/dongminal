#!/bin/bash
set -e
cd "$(dirname "$0")/.."

[ -f .env ] && set -a && source .env && set +a

PORT="${PORT:-58146}"
BINARY="${BINARY:-dongminal}"
LOG="${LOG:-/tmp/dongminal.log}"
DONGMINAL_HOME="${DONGMINAL_HOME:-$HOME/.dongminal}"

if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "Stopping existing process on port $PORT..."
  lsof -ti :$PORT | xargs kill 2>/dev/null
  sleep 1
fi

echo "Building..."
go build -o $BINARY ./cmd/dongminal

echo "Starting on port $PORT..."
PORT=$PORT DONGMINAL_HOME=$DONGMINAL_HOME ./$BINARY > "$LOG" 2>&1 &
echo "PID: $!"
sleep 1

if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "✅ Running on http://localhost:$PORT"
else
  echo "❌ Failed to start. Check $LOG"
  cat "$LOG"
  exit 1
fi
