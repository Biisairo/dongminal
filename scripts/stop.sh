#!/bin/bash
set -e
cd "$(dirname "$0")/.."
# Load .env safely — reads KEY=VALUE lines only, never executes shell code.
# Leading `~/` in a value is expanded to $HOME; other variable references
# like $HOME inside values are not expanded.
_load_env() {
  if [ -f .env ]; then
    while IFS='=' read -r key value; do
      case "$key" in
        ''|\#*) continue ;;
        *)
          case "$value" in
            '~'|'~/'*) value="$HOME${value#\~}" ;;
          esac
          export "$key=$value"
          ;;
      esac
    done < .env
  fi
}
_load_env

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

dongminal_ok=0
dongminald_ok=0

# ── Stop dongminal (web server) ──────────────────────────────
if lsof -ti :$PORT >/dev/null 2>&1; then
  echo "Stopping dongminal on port $PORT..."
  lsof -ti :$PORT | xargs kill 2>/dev/null
  sleep 1
  if lsof -ti :$PORT >/dev/null 2>&1; then
    echo "Force killing dongminal..."
    lsof -ti :$PORT | xargs kill -9 2>/dev/null
    sleep 1
  fi
  if lsof -ti :$PORT >/dev/null 2>&1; then
    echo "❌ Failed to stop dongminal"
  else
    echo "✅ dongminal stopped"
    dongminal_ok=1
  fi
else
  echo "dongminal not running on port $PORT"
  dongminal_ok=1  # already stopped
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
      dongminald_ok=1
    else
      rm -f "${PID_FILE}"
      rm -f "${SOCK_PATH}"
      echo "dongminald not running (stale pidfile removed)"
      dongminald_ok=1
    fi
  else
    echo "dongminald not running (no pidfile)"
    dongminald_ok=1
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
  if [ "$dongminal_ok" = "1" ] && [ "$dongminald_ok" = "1" ]; then
    exit 0
  else
    exit 1
  fi
else
  if [ "$dongminal_ok" = "1" ]; then
    exit 0
  else
    exit 1
  fi
fi
