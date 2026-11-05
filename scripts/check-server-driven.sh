#!/usr/bin/env bash
#
# 화면에 남는 판정 코드 검사 (SERVER_DRIVEN_ACTIONS_SRS NFR-SDA-3 · TC-SDA-13).
#
# 판정의 주인은 서버다(D-SDA-1). 화면에서 없앤 판정 함수·표가 web/js 에 다시 생기면
# 두 벌이 되돌아온 것이다. 묶음마다 없앤 이름을 아래 목록에 더한다.
# 주석 줄은 지나간다 — "이전 동작" 기록이 옛 이름을 인용한다.
#
# 사용: scripts/check-server-driven.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

REMOVED=(
  gitJobSlotsOf          # GR-1e: 요청 키 → 칸 규칙
  GIT_JOB_COMMON_KEYS    # GR-1e
  GIT_JOB_INDEX_EXEMPT   # GR-1e: 미리 막지 않는 쓰기 목록
  GIT_STASH_UNTRACKED_ONLY  # M-9: stash 만들기의 화면 판정 문구
)

pat=$(IFS='|'; echo "${REMOVED[*]}")
hits=$(grep -rnwE "$pat" web/js --include='*.js' \
        | grep -v '^web/js/test/' \
        | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*)')
if [[ -n "$hits" ]]; then
  echo "❌ 서버로 옮긴 판정이 화면에 다시 생겼습니다 (NFR-SDA-3):"
  echo "$hits" | sed 's/^/     /'
  echo "   판정은 서버의 답(actionState·panel.actionOf)으로 그리세요."
  exit 1
fi
echo "server-driven ok — 없앤 판정 ${#REMOVED[@]}개가 web/js 에 없다"
