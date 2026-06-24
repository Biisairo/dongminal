#!/usr/bin/env bash
# 테스트용 dongminal 인스턴스를 고정 포트 12345 / 격리된 DONGMINAL_HOME 으로 기동.
# 운영 인스턴스(58146) 와 분리되어 코드 변경 검증에 사용.
#
# DAEMON_SPLIT_SRS: dongminald도 별도 관리.
#   --restart-daemon: dongminald까지 재시작 (세션 소실)
#   기본: dongminal만 재시작 (dongminald 유지 → 세션 보존)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}"

PORT="${TEST_PORT:-12345}"
TEST_HOME="${TEST_DONGMINAL_HOME:-${REPO_DIR}/.test-dongminal}"
PID_FILE="${TEST_HOME}/server.pid"
DAEMON_PID_FILE="${TEST_HOME}/paned.pid"
SOCK_PATH="${TEST_HOME}/paned.sock"
LOG_FILE="${TEST_HOME}/server.log"
BINARY="${TEST_HOME}/dongminal"

RESTART_DAEMON=0
for arg in "$@"; do
  case "$arg" in
    --restart-daemon) RESTART_DAEMON=1 ;;
  esac
done

mkdir -p "${TEST_HOME}"

# ── Stop old dongminal (web server) ─────────────────────────
if [[ -f "${PID_FILE}" ]]; then
  OLD_PID="$(cat "${PID_FILE}")"
  if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "test_start: stopping old dongminal pid=${OLD_PID}"
    kill "${OLD_PID}" 2>/dev/null || true
    sleep 1
    kill -9 "${OLD_PID}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}"
fi

# ── Optionally restart dongminald ───────────────────────────
if [ "$RESTART_DAEMON" = "1" ]; then
  echo "test_start: restarting dongminald (sessions will be lost)"
  if [[ -f "${DAEMON_PID_FILE}" ]]; then
    DAEMON_PID="$(cat "${DAEMON_PID_FILE}")"
    if [[ -n "${DAEMON_PID}" ]] && kill -0 "${DAEMON_PID}" 2>/dev/null; then
      kill "${DAEMON_PID}" 2>/dev/null || true
      sleep 1
      kill -9 "${DAEMON_PID}" 2>/dev/null || true
    fi
    rm -f "${DAEMON_PID_FILE}"
  fi
  rm -f "${SOCK_PATH}"
else
  if [[ -S "${SOCK_PATH}" ]]; then
    echo "test_start: dongminald already running (sessions preserved)"
  fi
fi

# ── Build ───────────────────────────────────────────────────
echo "build: go build → ${BINARY}"
go build -o "${BINARY}" ./cmd/dongminal

# ── Start dongminal ─────────────────────────────────────────
echo "start: PORT=${PORT} DONGMINAL_HOME=${TEST_HOME}"
PORT="${PORT}" DONGMINAL_HOME="${TEST_HOME}" \
  nohup "${BINARY}" >> "${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"

# ── Wait for readiness ──────────────────────────────────────
for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/ping" >/dev/null 2>&1; then
    echo "ready: http://127.0.0.1:${PORT}  (pid=$(cat "${PID_FILE}"))"
    if [ -S "${SOCK_PATH}" ]; then
      echo "       dongminald connected at ${SOCK_PATH}"
    fi
    echo "log:   ${LOG_FILE}"
    exit 0
  fi
  sleep 0.1
done

echo "test_start: ping 응답 없음 (5초 타임아웃). 로그 확인: ${LOG_FILE}" >&2
tail -20 "${LOG_FILE}" >&2
exit 1
