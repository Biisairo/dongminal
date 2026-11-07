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
  GIT_COMMIT_WHY_TEXT       # GR-3f: 커밋 버튼의 화면 판정 표
  GIT_COMMIT_WHY_NOTHING_CODE  # GR-3f
  GIT_TAG_WHY_NEED_MSG         # GV-e: 태그 메시지의 화면 판정 문구
  GIT_BR_UPSTREAM_WHY_UNKNOWN  # GV-f: upstream 목록 대조
  GIT_STASH_BRANCH_NEED_NAME   # GV-c: stash 브랜치 빈 이름
  GIT_WT_NEED_NAME GIT_WT_NEED_REF   # GV-c: worktree 빈 입력
  GIT_RM_WHY_NAME GIT_RM_WHY_URL     # GV-c: 원격 추가 빈 입력
  GIT_CO_WHY_NO_REV GIT_CO_WHY_NO_PATH  # GV-c: 비교 빈 입력
  GIT_ADD_REPO_NEED_PATH       # GV-c: 저장소 추가 빈 경로
  _split                       # GV-g: 원격 ref 를 원격·브랜치로 가르는 화면 규칙
  GIT_TAG_KIND_OPTS GIT_CO_RESET_MODES  # GV-h: 서버가 보내는 목록의 사본
  edCountTree EDITOR_DEL_COUNT_MAX  # F-g: 화면이 세던 삭제 항목 수와 그 상한
  EDITOR_NAME_INVALID EDITOR_MOVE_INTO_SELF  # F-k·F-l: 이름의 / · 자기 하위 이동
  EDITOR_ADD_NEED_PATH  # F-m: 편집기 루트 추가의 빈 경로
  startTryable  # X-b: 샌드박스 시작을 화면이 고르던 사실
  _aclV4 _aclCidrHas _aclCoversYou  # X-d: 잠김 경고의 IPv4 판정
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
