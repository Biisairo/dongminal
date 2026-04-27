#!/bin/bash
set -e
cd "$(dirname "$0")/.."

[ -f .env ] && set -a && source .env && set +a

EXPOSE=0
for arg in "$@"; do
  case "$arg" in
    --expose) EXPOSE=1 ;;
    --local) EXPOSE=0 ;;
    -h|--help)
      echo "Usage: $0 [--expose|--local]"
      echo "  --local   (default) bind to 127.0.0.1 only (same PC access)"
      echo "  --expose  bind to 0.0.0.0 (LAN-accessible)"
      exit 0
      ;;
  esac
done

PORT="${PORT:-58146}"
BINARY="${BINARY:-dongminal}"
LOG="${LOG:-/tmp/dongminal.log}"
DONGMINAL_HOME="${DONGMINAL_HOME:-$HOME/.dongminal}"

if [ "$EXPOSE" = "1" ]; then
  DONGMINAL_HOST="${DONGMINAL_HOST:-0.0.0.0}"
else
  DONGMINAL_HOST="${DONGMINAL_HOST:-127.0.0.1}"
fi

if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "Stopping existing process on port $PORT..."
  lsof -ti :$PORT | xargs kill 2>/dev/null
  sleep 1
fi

echo "Building..."
go build -o $BINARY ./cmd/dongminal

echo "Starting on $DONGMINAL_HOST:$PORT..."
PORT=$PORT DONGMINAL_HOST=$DONGMINAL_HOST DONGMINAL_HOME=$DONGMINAL_HOME ./$BINARY > "$LOG" 2>&1 &
echo "PID: $!"
sleep 1

if lsof -ti :$PORT >/dev/null 2>&1; then
  if [ "$DONGMINAL_HOST" = "0.0.0.0" ] || [ "$DONGMINAL_HOST" = "::" ]; then
    echo "✅ Running on http://$DONGMINAL_HOST:$PORT (exposed to LAN)"
  else
    echo "✅ Running on http://$DONGMINAL_HOST:$PORT (local-only)"
  fi
else
  echo "❌ Failed to start. Check $LOG"
  cat "$LOG"
  exit 1
fi
