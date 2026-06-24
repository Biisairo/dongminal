#!/usr/bin/env bash
# test_start.sh 로 기동한 테스트 인스턴스를 종료.
# DAEMON_SPLIT_SRS: dongminal + dongminald 모두 종료.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

TEST_HOME="${TEST_DONGMINAL_HOME:-${REPO_DIR}/.test-dongminal}"
PID_FILE="${TEST_HOME}/server.pid"
DAEMON_PID_FILE="${TEST_HOME}/paned.pid"
SOCK_PATH="${TEST_HOME}/paned.sock"

# ── Stop dongminal (web server) ─────────────────────────────
if [[ -f "${PID_FILE}" ]]; then
  PID="$(cat "${PID_FILE}")"
  if [[ -n "${PID}" ]] && kill -0 "${PID}" 2>/dev/null; then
    echo "stop: dongminal pid=${PID}"
    kill "${PID}"
    for _ in $(seq 1 30); do
      if ! kill -0 "${PID}" 2>/dev/null; then
        echo "✅ dongminal stopped"
        break
      fi
      sleep 0.1
    done
    if kill -0 "${PID}" 2>/dev/null; then
      echo "force kill dongminal"
      kill -9 "${PID}" 2>/dev/null || true
    fi
  fi
  rm -f "${PID_FILE}"
else
  echo "dongminal PID file not found (already stopped)"
fi

# ── Stop dongminald (PTY daemon) ────────────────────────────
if [[ -f "${DAEMON_PID_FILE}" ]]; then
  DAEMON_PID="$(cat "${DAEMON_PID_FILE}")"
  if [[ -n "${DAEMON_PID}" ]] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
    echo "stop: dongminald pid=${DAEMON_PID}"
    kill "${DAEMON_PID}"
    sleep 0.5
    kill -9 "${DAEMON_PID}" 2>/dev/null || true
    echo "✅ dongminald stopped"
  fi
  rm -f "${DAEMON_PID_FILE}"
fi

# ── Clean up socket ─────────────────────────────────────────
rm -f "${SOCK_PATH}"

echo "test environment stopped."
