#!/usr/bin/env bash
# 테스트용 dongminal 인스턴스를 고정 포트 12345 / 격리된 DONGMINAL_HOME 으로 기동.
# 운영 인스턴스(58146) 와 분리되어 코드 변경 검증에 사용.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}"

PORT="${TEST_PORT:-12345}"
TEST_HOME="${TEST_DONGMINAL_HOME:-${REPO_DIR}/.test-dongminal}"
PID_FILE="${TEST_HOME}/server.pid"
LOG_FILE="${TEST_HOME}/server.log"

mkdir -p "${TEST_HOME}"

if [[ -f "${PID_FILE}" ]]; then
  OLD_PID="$(cat "${PID_FILE}")"
  if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "test_start: 이미 실행 중 (pid=${OLD_PID}). 먼저 test_stop.sh 실행." >&2
    exit 1
  fi
  rm -f "${PID_FILE}"
fi

echo "build: go build → ${TEST_HOME}/dongminal"
go build -o "${TEST_HOME}/dongminal" ./cmd/dongminal

echo "start: PORT=${PORT} DONGMINAL_HOME=${TEST_HOME}"
PORT="${PORT}" DONGMINAL_HOME="${TEST_HOME}" \
  nohup "${TEST_HOME}/dongminal" >> "${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"

for _ in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/ping" >/dev/null 2>&1; then
    echo "ready: http://127.0.0.1:${PORT}  (pid=$(cat "${PID_FILE}"))"
    echo "log:   ${LOG_FILE}"
    exit 0
  fi
  sleep 0.1
done

echo "test_start: ping 응답 없음 (5초 타임아웃). 로그 확인: ${LOG_FILE}" >&2
exit 1
