#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Load .env safely — reads KEY=VALUE lines only, never executes shell code.
# Limitation: variable references like $HOME inside values are not expanded.
_load_env() {
  if [ -f .env ]; then
    while IFS='=' read -r key value; do
      case "$key" in
        ''|\#*) continue ;;
        *) export "$key=$value" ;;
      esac
    done < .env
  fi
}
_load_env

EXPOSE=0
RESTART_DAEMON=0

for arg in "$@"; do
  case "$arg" in
    --expose) EXPOSE=1 ;;
    --restart-daemon) RESTART_DAEMON=1 ;;
    -h|--help)
      echo "Usage: $0 [--expose] [--restart-daemon]"
      echo "  (default)    bind to 127.0.0.1 only, keep dongminald sessions"
      echo "  --expose     bind to 0.0.0.0 (LAN-accessible)"
      echo "  --restart-daemon  also restart dongminald (loses terminal sessions)"
      exit 0
      ;;
  esac
done

PORT="${PORT:-58146}"
BINARY="${BINARY:-dongminal}"
LOG="${LOG:-/tmp/dongminal.log}"
DONGMINAL_HOME="${DONGMINAL_HOME:-$HOME/.dongminal}"
SOCK_PATH="${DONGMINAL_HOME}/paned.sock"

if [ "$EXPOSE" = "1" ]; then
  DONGMINAL_HOST="${DONGMINAL_HOST:-0.0.0.0}"
else
  DONGMINAL_HOST="${DONGMINAL_HOST:-127.0.0.1}"
fi

# ── Stop old dongminal (web server) ──────────────────────────
if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "Stopping existing dongminal on port $PORT..."
  lsof -ti :$PORT | xargs kill 2>/dev/null
  sleep 1
  if lsof -ti :$PORT >/dev/null 2>&1; then
    echo "Force killing dongminal..."
    lsof -ti :$PORT | xargs kill -9 2>/dev/null
    sleep 1
  fi
fi

# ── Optionally restart dongminald (PTY daemon) ───────────────
if [ "$RESTART_DAEMON" = "1" ]; then
  echo "Restarting dongminald (terminal sessions will be lost)..."
  # Kill existing dongminald by pidfile
  PID_FILE="${DONGMINAL_HOME}/paned.pid"
  if [ -f "${PID_FILE}" ]; then
    DAEMON_PID=$(cat "${PID_FILE}")
    if [ -n "${DAEMON_PID}" ] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
      echo "Stopping dongminald pid=${DAEMON_PID}..."
      kill "${DAEMON_PID}" 2>/dev/null
      sleep 1
      kill -9 "${DAEMON_PID}" 2>/dev/null || true
    fi
    rm -f "${PID_FILE}"
  fi
  rm -f "${SOCK_PATH}"
  echo "dongminald stopped."
else
  # Check if dongminald is already running; if not, dongminal will auto-spawn it
  if [ -S "${SOCK_PATH}" ]; then
    echo "dongminald already running (sessions will be preserved)"
  else
    echo "dongminald not running — dongminal will auto-start it"
  fi
fi

# ── Build ────────────────────────────────────────────────────
echo "Building..."
go build -o "$BINARY" ./cmd/dongminal

# ── Start dongminal ──────────────────────────────────────────
echo "Starting dongminal on $DONGMINAL_HOST:$PORT..."
PORT=$PORT DONGMINAL_HOST=$DONGMINAL_HOST DONGMINAL_HOME=$DONGMINAL_HOME ./"$BINARY" > "$LOG" 2>&1 &
echo "dongminal PID: $!"

# ── Wait for readiness ───────────────────────────────────────
for i in $(seq 1 10); do
  if curl -sf --max-time 1 "http://$DONGMINAL_HOST:$PORT/api/ping" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# ── Health check ─────────────────────────────────────────────
if lsof -ti :$PORT >/dev/null 2>&1; then
  if [ "$DONGMINAL_HOST" = "0.0.0.0" ] || [ "$DONGMINAL_HOST" = "::" ]; then
    echo "✅ dongminal running on http://$DONGMINAL_HOST:$PORT (exposed to LAN)"
  else
    echo "✅ dongminal running on http://$DONGMINAL_HOST:$PORT (local-only)"
  fi
  if [ -S "${SOCK_PATH}" ]; then
    echo "✅ dongminald connected at ${SOCK_PATH}"
  fi
else
  echo "❌ Failed to start. Check $LOG"
  tail -20 "$LOG"
  exit 1
fi
