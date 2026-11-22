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
USER_HOME=/tmp/dm-demo/user
BIN=./dongminal

[[ -x "$BIN" ]] || { echo "먼저 빌드: scripts/build.sh" >&2; exit 1; }

bash scripts/shots/demo-repo.sh
"$BIN" stop --all --port "$PORT" --home "$HOME_DIR" >/dev/null 2>&1 || true
# 매번 빈 홈에서 시작한다 — 남은 워크스페이스(지난 촬영의 분할 등)가 그림에 섞인다.
rm -rf "$HOME_DIR" "$USER_HOME" && mkdir -p "$HOME_DIR" "$USER_HOME"
# 셸은 빈 가짜 홈의 bash 다 — 사용자의 셸 설정을 읽으면 프롬프트에 사용자명@호스트명이 보인다.
HOME="$USER_HOME" SHELL=/bin/bash "$BIN" start --port "$PORT" --home "$HOME_DIR" >/dev/null
trap '"$BIN" stop --all --port "$PORT" --home "$HOME_DIR" >/dev/null 2>&1 || true' EXIT

SHOT_BASE="http://127.0.0.1:$PORT" npx playwright test scripts/shots/capture.spec.ts \
  --config=scripts/shots/playwright.config.ts --reporter=line

echo "그림: docs/images/"
