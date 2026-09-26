#!/usr/bin/env bash
#
# 샤드 하나를 돈다. `make e2e` 가 이것을 8번 병렬로 부른다.
#
# **xargs 에서 빼낸 이유**: macOS 의 `xargs -I` 는 치환 뒤 줄 길이를 255바이트로
# 묶는다. 본문을 인라인으로 두면 조금만 길어져도 `command line cannot be
# assembled, too long` 으로 멎는다 — 실측으로 그렇게 됐다.
#
# 사용: scripts/e2e-shard-run.sh <샤드번호> <샤드수>
set -o pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

i="${1:?샤드 번호}"; n="${2:?샤드 수}"

# 돌 파일은 **시간으로** 갈린다 (개수가 아니다). 목록은 `e2e/` 에서 파생된다.
specs=$(node scripts/e2e-shard.mjs --list "$i/$n") || exit 1

# 샤드마다 포트 뿌리와 산출물 자리를 옮긴다 (FR-EPL-14). 홈은 pid 로 이미 갈린다.
# `DM_E2E_KEEP_PEERS=1` 이 청소를 자기 뿌리로 한정한다 — 없으면 setup/teardown 이
# 아직 도는 다른 샤드의 바이너리를 지운다.
#
# JSON 리포트는 `make e2e-rebalance` 의 입력이다.
#
# 뿌리는 `E2E_PORT_BASE` 로 옮길 수 있다 (FR-OPT-16-4) — 같은 기계에서 두 전량 실행을
# 겹쳐 돌 때 쓴다. 기본 58147 은 운영 포트 58146 의 **바로 위**이고 대역은 위로만
# 자란다(샤드 n × 10). 옮긴 뿌리의 대역이 운영 포트를 덮으면 돌지 않는다 — 실사용
# 인스턴스와 포트를 다투게 된다.
root="${E2E_PORT_BASE:-58147}"
prod=58146
case "$root" in ''|*[!0-9]*) echo "[샤드 $i/$n] E2E_PORT_BASE=$root 는 포트 번호가 아니다" >&2; exit 2 ;; esac
if [ "$root" -le "$prod" ] && [ "$prod" -lt $((root + n * 10)) ]; then
  echo "[샤드 $i/$n] E2E_PORT_BASE=$root 의 대역($root~$((root + n * 10 - 1)))이 운영 포트 $prod 를 덮는다" >&2
  exit 2
fi
DM_E2E_KEEP_PEERS=1 \
E2E_PORT_BASE=$((root + (i - 1) * 10)) \
PLAYWRIGHT_JSON_OUTPUT_NAME="test-results/s$i/report.json" \
  npx playwright test $specs \
    --output="test-results/s$i" \
    --reporter=line,json,./e2e/parity-reporter.ts \
  2>&1 | sed "s|^|[샤드 $i/$n] |"
