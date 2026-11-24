#!/usr/bin/env bash
#
# git 쓰기 파이프라인 우회 검사 (DRIFT_RECLAIM_SRS FR-DRC-8, GO_REMOVAL_SRS G-21).
#
# 규칙은 하나다 — **`gitapi` 의 쓰기는 전부 `gitWrite` 파이프라인(`write.rs`)을 지난다.**
# 그 밖에서 `git_resolve_repo`·`git_status_before`·`git_apply` 를 직접 부르면, 그것은
# 파이프라인을 우회한 것이고 순서 불변식이 타입이 아니라 주석으로 돌아간다.
#
# `check-seams.sh`·`check-timers.sh` 와 같은 형태다. 그 파일들의 주석이 남긴
# 이력이 이 검사가 필요한 이유이기도 하다 — **규약은 선언으로 지켜지지 않는다.**
#
# 이 검사가 없던 동안 실제로 일어난 일 (DRIFT_RECLAIM_SRS §2.2):
#
#   - Go 기준선 `handlers_git_submodule.go` 의 쓰기 둘이 사다리를 통째로 복제했다
#     (104-119 ≡ 140-155, 16줄 완전 중복). 그 표면에는 단위 테스트도 0개였다.
#   - 복제본은 이미 갈라져 있었다 — 같은 "confirm 이 없다" 가 한쪽은
#     `bad_request`, 다른 쪽은 `confirmation_required` 로 나갔고, 화면은 그
#     둘을 "잘못된 요청입니다" 와 "확인이 필요합니다" 로 옮겼다.
#
# 사용: scripts/check-gitwrite.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
git 쓰기 파이프라인 우회 검사

  scripts/check-gitwrite.sh

규칙은 하나다 — gitapi 의 쓰기는 전부 gitWrite 파이프라인(write.rs)을
지난다. 그 밖에서 git_resolve_repo·git_status_before·git_apply 를 직접 부르면
파이프라인을 우회한 것이다.

허용되는 자리:
  write.rs           파이프라인 그 자체
  handlers_git.rs    git_repo_param — 읽기 경로의 repo 해석 (쓰기가 아니다)

새 쓰기 표면을 만들 때는 self.begin_write(domain/git 이 실행) 또는
self.begin_service_write(자기 Manager 가 실행)로 연다.

설계는 docs/internal/DRIFT_RECLAIM_SRS.md 참조.
EOF
  exit 0
fi

DIR=rust/crates/webserver/gitapi/src
ROUTES=$DIR/routes.rs
BODY=scripts/lib/rs-fn-body.pl
source scripts/lib/rs-src.sh

if [[ ! -f "$ROUTES" ]]; then
  echo "❌ $ROUTES 가 없습니다 — 검사할 라우트 표가 없어 빈 통과를 막습니다."
  exit 1
fi

EXEMPT="^$DIR/write\.rs:|^$DIR/handlers_git\.rs:[0-9]+:\s+let root = self\.git_resolve_repo\("

PATTERNS=(
  "git_resolve_repo 직접 호출|\.git_resolve_repo\("
  "git_status_before 직접 호출|\bgit_status_before\("
  "git_apply 직접 호출|\.git_apply\("
)

fail=0
for entry in "${PATTERNS[@]}"; do
  label="${entry%%|*}"
  pattern="${entry#*|}"
  # 테스트는 검사하지 않는다 — 단계 하나를 좁게 확인하는 테스트가 정당하다.
  # 주석 줄은 코드가 아니다 (파이프라인 문서가 사다리 예시를 인용한다).
  hits=$(grep -rnE "$pattern" "$DIR" --include='*.rs' 2>/dev/null \
          | rs_drop_tests \
          | grep -vE '^\S+:[0-9]+:\s*//' \
          | grep -vE "$EXEMPT")
  if [[ -n "$hits" ]]; then
    echo "❌ $label — gitWrite 파이프라인을 우회했습니다:"
    echo "$hits" | sed 's/^/     /'
    fail=1
  fi
done

# ── POST 핸들러가 파이프라인을 여는가 (FR-DRC-8 의 나머지 반) ──
#
# 위 검사는 "우회하는 호출이 있는가" 만 본다. 새 POST 핸들러가 파이프라인을 **아예
# 열지 않고** core 를 직접 부르면 걸리지 않는다. routes.rs 의 `post(…, h!(이름))` 마다
# 핸들러 본문(또는 한 단계 위임한 `self.x(r…)` 의 본문)이 begin_write·begin_service_write
# 를 부르는지 본다.
posts=$(grep -oE 'post\("[^"]+", h!\((need_git )?[a-z_0-9]+' "$ROUTES" \
         | sed -E 's/.*h!\((need_git )?//' | sort -u)
if [[ -z "$posts" ]]; then
  echo "❌ $ROUTES 에서 POST 핸들러를 하나도 읽지 못했습니다 — 빈 통과를 막습니다."
  exit 1
fi

src=$(rs_src_files "$DIR")

body_of() {
  printf '%s\n' "$src" | xargs perl "$BODY" "$1"
}

opens_pipeline() {
  local body; body=$(body_of "$1")
  [[ -z "$body" ]] && return 0
  grep -qE 'begin_write(::<[^>]*>)?\(|begin_service_write(::<[^>]*>)?\(' <<<"$body" && return 0
  local callee
  for callee in $(grep -oE 'self\.[a-z][a-z0-9_]*\(r\b' <<<"$body" | sed -E 's/self\.//;s/\(r$//' | sort -u); do
    grep -qE 'begin_write(::<[^>]*>)?\(|begin_service_write(::<[^>]*>)?\(' <<<"$(body_of "$callee")" && return 0
  done
  return 1
}

# 저장소 범위가 아닌 POST — 대상 저장소가 아직 없거나(init) 핀 목록만 바꾼다.
NOT_REPO_SCOPED='^(api_git_init|api_git_pin|api_git_unpin)$'

missing=""
for h in $posts; do
  [[ "$h" =~ $NOT_REPO_SCOPED ]] && continue
  opens_pipeline "$h" || missing+="     $h"$'\n'
done

if [[ -n "$missing" ]]; then
  echo "❌ POST 핸들러가 gitWrite 파이프라인을 열지 않습니다:"
  printf '%s' "$missing"
  echo "     → self.begin_write(...) 또는 self.begin_service_write(...) 로 여십시오."
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "✓ git 쓰기가 전부 gitWrite 파이프라인을 지난다 (V-4 통과)"
fi
exit $fail
