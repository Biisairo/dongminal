#!/bin/bash
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && source .env && set +a

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
    if [ -n "${DAEMON_PID}" ] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
      echo "✅ dongminald pid=${DAEMON_PID} socket=${SOCK_PATH}"
      OK=$((OK + 1))
    else
      echo "⚠️  dongminald socket exists but pid=${DAEMON_PID} not alive"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "⚠️  dongminald socket exists but no pidfile"
    FAIL=$((FAIL + 1))
  fi
else
  # No socket — dongminald might not have started yet, or dongminal
  # is running in direct mode (backward compatible). Not an error.
  echo "ℹ️  dongminald socket not found (direct mode or not yet started)"
fi

# ── Result ───────────────────────────────────────────────────
if [ $FAIL -gt 0 ]; then
  exit 1
fi
exit 0
