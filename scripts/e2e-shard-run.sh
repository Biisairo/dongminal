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
DM_E2E_KEEP_PEERS=1 \
E2E_PORT_BASE=$((58147 + (i - 1) * 10)) \
PLAYWRIGHT_JSON_OUTPUT_NAME="test-results/s$i/report.json" \
  npx playwright test $specs \
    --output="test-results/s$i" \
    --reporter=line,json,./e2e/parity-reporter.ts \
  2>&1 | sed "s|^|[샤드 $i/$n] |"
