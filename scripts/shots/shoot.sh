#!/usr/bin/env bash
# README 의 그림을 다시 찍는다 (README_REWRITE_SRS FR-RDM-16).
#
#   scripts/shots/shoot.sh
#
# **격리 인스턴스**를 임시 홈·전용 포트로 띄우고 거기서만 찍는다 — 운영
# 워크스페이스에는 홈 경로·호스트명·실제 저장소 이름이 보이고 README 는 공개된다.
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT=58199
HOME_DIR=/tmp/dm-demo/home
BIN=./dongminal

[[ -x "$BIN" ]] || { echo "먼저 빌드: scripts/build.sh" >&2; exit 1; }

bash scripts/shots/demo-repo.sh
"$BIN" stop --port "$PORT" --home "$HOME_DIR" >/dev/null 2>&1 || true
"$BIN" start --port "$PORT" --home "$HOME_DIR" >/dev/null
trap '"$BIN" stop --all --port "$PORT" --home "$HOME_DIR" >/dev/null 2>&1 || true' EXIT

SHOT_BASE="http://127.0.0.1:$PORT" npx playwright test scripts/shots/capture.spec.ts \
  --config=scripts/shots/playwright.config.ts --reporter=line

echo "그림: docs/images/"
