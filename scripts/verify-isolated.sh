#!/usr/bin/env bash
#
# darwin 실동작 검증 — `dongminal verify` 를 부르는 껍데기다.
#
# **검사의 정의는 이 스크립트에 없다.** Go 한 벌(internal/ctl/cli/verify.go)에 있고,
# CI 의 Linux·Windows 도 그 한 벌을 돈다 — 세 대상이 같은 목록을 검사한다
# (E2E_UNIFICATION_SRS FR-E2I-4). 종전에는 여기 21항목, CI 에 bash 5단계,
# PowerShell 5단계로 세 벌이 흩어져 있었다.
#
# 격리 가드도 Go 안으로 옮겼다 (FR-E2G-1). 기본 포트 58146 이거나 홈이 격리 홈이
# 아니면 verify 가 스스로 멈춘다. 그 가드가 없어서 운영 인스턴스를 SIGTERM →
# SIGKILL 하고 터미널 세션을 잃은 사고가 실제로 있었다. verify 는 `stop` 을 쓰지
# 않고 자기가 띄운 pid 와 격리 홈의 paned.pid 만 직접 끝낸다 (FR-E2G-4).
#
# 사용: scripts/verify-isolated.sh [--repo <경로>]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BIN="$REPO_ROOT/dongminal"
go build -o "$BIN" ./cmd/dongminal
exec "$BIN" verify "$@"
