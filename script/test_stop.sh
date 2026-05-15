#!/usr/bin/env bash
# test_start.sh 로 기동한 테스트 인스턴스를 종료.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

TEST_HOME="${TEST_DONGMINAL_HOME:-${REPO_DIR}/.test-dongminal}"
PID_FILE="${TEST_HOME}/server.pid"

if [[ ! -f "${PID_FILE}" ]]; then
  echo "test_stop: PID 파일 없음 (${PID_FILE}). 이미 종료된 것으로 간주."
  exit 0
fi

PID="$(cat "${PID_FILE}")"
if [[ -z "${PID}" ]] || ! kill -0 "${PID}" 2>/dev/null; then
  echo "test_stop: pid=${PID} 프로세스 없음. PID 파일 정리."
  rm -f "${PID_FILE}"
  exit 0
fi

echo "stop: pid=${PID} (SIGTERM)"
kill "${PID}"
for _ in $(seq 1 30); do
  if ! kill -0 "${PID}" 2>/dev/null; then
    rm -f "${PID_FILE}"
    echo "stopped."
    exit 0
  fi
  sleep 0.1
done

echo "test_stop: SIGTERM 미수신 — SIGKILL"
kill -9 "${PID}" 2>/dev/null || true
rm -f "${PID_FILE}"
