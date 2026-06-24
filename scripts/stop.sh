#!/bin/bash
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && source .env && set +a

PORT="${PORT:-58146}"
DONGMINAL_HOME="${DONGMINAL_HOME:-$HOME/.dongminal}"
SOCK_PATH="${DONGMINAL_HOME}/paned.sock"
PID_FILE="${DONGMINAL_HOME}/paned.pid"

STOP_ALL=0
for arg in "$@"; do
  case "$arg" in
    --all) STOP_ALL=1 ;;
    -h|--help)
      echo "Usage: $0 [--all]"
      echo "  (no flag)  stop dongminal only (dongminald keeps sessions alive)"
      echo "  --all      stop both dongminal and dongminald"
      exit 0
      ;;
  esac
done

dongminal_stopped=0
dongminald_stopped=0

# ── Stop dongminal (web server) ──────────────────────────────
if lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Stopping dongminal on port $PORT..."
  lsof -tiTCP:$PORT -sTCP:LISTEN | xargs kill 2>/dev/null
  sleep 1
  if lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Force killing dongminal..."
    lsof -tiTCP:$PORT -sTCP:LISTEN | xargs kill -9 2>/dev/null
    sleep 1
  fi
  if lsof -tiTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
    echo "❌ Failed to stop dongminal"
  else
    echo "✅ dongminal stopped"
    dongminal_stopped=1
  fi
else
  echo "dongminal not running on port $PORT"
  dongminal_stopped=1  # already stopped
fi

# ── Optionally stop dongminald (PTY daemon) ─────────────────
if [ "$STOP_ALL" = "1" ]; then
  if [ -f "${PID_FILE}" ]; then
    DAEMON_PID=$(cat "${PID_FILE}")
    if [ -n "${DAEMON_PID}" ] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
      echo "Stopping dongminald pid=${DAEMON_PID}..."
      kill "${DAEMON_PID}" 2>/dev/null
      sleep 1
      kill -9 "${DAEMON_PID}" 2>/dev/null || true
      rm -f "${PID_FILE}"
      rm -f "${SOCK_PATH}"
      echo "✅ dongminald stopped"
      dongminald_stopped=1
    else
      rm -f "${PID_FILE}"
      echo "dongminald not running (stale pidfile removed)"
      dongminald_stopped=1
    fi
  else
    echo "dongminald not running (no pidfile)"
    dongminald_stopped=1
  fi
else
  if [ -f "${PID_FILE}" ]; then
    DAEMON_PID=$(cat "${PID_FILE}")
    if [ -n "${DAEMON_PID}" ] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
      echo "dongminald still running pid=${DAEMON_PID} (sessions preserved)"
    fi
  fi
fi

# ── Final status ─────────────────────────────────────────────
if [ "$STOP_ALL" = "1" ]; then
  if [ "$dongminal_stopped" = "1" ] && [ "$dongminald_stopped" = "1" ]; then
    exit 0
  else
    exit 1
  fi
else
  if [ "$dongminal_stopped" = "1" ]; then
    exit 0
  else
    exit 1
  fi
fi
