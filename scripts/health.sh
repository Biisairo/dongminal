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

PORT="${PORT:-58146}"
DONGMINAL_HOME="${DONGMINAL_HOME:-$HOME/.dongminal}"
SOCK_PATH="${DONGMINAL_HOME}/paned.sock"
PID_FILE="${DONGMINAL_HOME}/paned.pid"

OK=0
FAIL=0

# ── Check dongminal (HTTP) ───────────────────────────────────
URL="http://localhost:${PORT}/"
if curl -sf --max-time 3 "$URL" > /dev/null 2>&1; then
  echo "✅ dongminal HTTP :${PORT}"
  OK=$((OK + 1))
else
  echo "❌ dongminal HTTP :${PORT} — not responding"
  FAIL=$((FAIL + 1))
fi

# ── Check dongminald (Unix socket) ───────────────────────────
if [ -S "${SOCK_PATH}" ]; then
  if [ -f "${PID_FILE}" ]; then
    DAEMON_PID=$(cat "${PID_FILE}")
    if [[ "$DAEMON_PID" =~ ^[0-9]+$ ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
      echo "✅ dongminald pid=${DAEMON_PID} socket=${SOCK_PATH}"
      OK=$((OK + 1))
    else
      echo "⚠️  dongminald socket exists but pid=${DAEMON_PID} not alive"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "ℹ️  dongminald socket exists but no pidfile"
    # Not an error — the daemon may be running without a pidfile
  fi
else
  # No socket — dongminald might not have started yet, or dongminal
  # is running in direct mode (backward compatible). Not an error.
  echo "ℹ️  dongminald socket not found (direct mode or not yet started)"
fi

# ── Result ───────────────────────────────────────────────────
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
