#!/usr/bin/env bash
#
# git 쓰기 파이프라인 우회 검사 (DRIFT_RECLAIM_SRS FR-DRC-8).
#
# 규칙은 하나다 — **`gitapi` 의 쓰기는 전부 `gitWrite` 파이프라인을 지난다.**
# 그 밖에서 `gitResolveRepo`·`gitStatusBefore`·`gitApply` 를 직접 부르면, 그것은
# 파이프라인을 우회한 것이고 순서 불변식이 타입이 아니라 주석으로 돌아간다.
#
# `check-seams.sh`·`check-timers.sh` 와 같은 형태다. 그 파일들의 주석이 남긴
# 이력이 이 검사가 필요한 이유이기도 하다 — **규약은 선언으로 지켜지지 않는다.**
#
# 이 검사가 없던 동안 실제로 일어난 일 (DRIFT_RECLAIM_SRS §2.2):
#
#   - `handlers_git_submodule.go` 의 쓰기 둘이 사다리를 통째로 복제했다
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

규칙은 하나다 — gitapi 의 쓰기는 전부 gitWrite 파이프라인(gitwrite.go)을
지난다. 그 밖에서 gitResolveRepo·gitStatusBefore·gitApply 를 직접 부르면
파이프라인을 우회한 것이다.

허용되는 자리:
  gitwrite.go        파이프라인 그 자체
  handlers_git.go    gitRepoParam — 읽기 경로의 repo 해석 (쓰기가 아니다)

새 쓰기 표면을 만들 때는 s.beginWrite(domain/git 이 실행) 또는
s.beginServiceWrite(자기 Manager 가 실행)로 연다.

설계는 docs/internal/DRIFT_RECLAIM_SRS.md 참조.
EOF
  exit 0
fi

DIR=internal/webserver/gitapi

# 파이프라인 그 자체와 읽기 경로의 해석기. 이 둘만 단계를 직접 부른다.
EXEMPT="^$DIR/gitwrite\.go:|^$DIR/handlers_git\.go:[0-9]+:\s+root, ok = s\.gitResolveRepo"

# 파이프라인의 단계들. 좌변은 화면에 보일 이름, 우변은 grep -E 패턴이다.
PATTERNS=(
  "gitResolveRepo 직접 호출|\.gitResolveRepo\("
  "gitStatusBefore 직접 호출|\.gitStatusBefore\("
  "gitApply 직접 호출|\.gitApply\("
)

fail=0
for entry in "${PATTERNS[@]}"; do
  label="${entry%%|*}"
  pattern="${entry#*|}"
  # 테스트는 검사하지 않는다 — 단계 하나를 좁게 확인하는 테스트가 정당하다.
  # 주석 줄은 코드가 아니다 (파이프라인 문서가 사다리 예시를 인용한다).
  hits=$(grep -rnE "$pattern" "$DIR" --include='*.go' 2>/dev/null \
          | grep -v '_test\.go:' \
          | grep -vE '^\S+:[0-9]+:\s*//' \
          | grep -vE "$EXEMPT")
  if [[ -n "$hits" ]]; then
    echo "❌ $label — gitWrite 파이프라인을 우회했습니다:"
    echo "$hits" | sed 's/^/     /'
    fail=1
  fi
done

# 쓰기 핸들러가 파이프라인을 아예 열지 않는 경우를 잡는다. POST 라우트의
# 핸들러 이름을 라우팅표에서 뽑아, 그 함수가 beginWrite 계열에 **닿는지** 본다.
#
# **라우팅표가 진실이다** — "이름에 Create 가 들어가면 쓰기" 같은 판정을 세우면
# 그 판정이 실제 라우팅과 어긋날 때 구멍이 생긴다.
#
# 위임을 따라간다. 얇은 핸들러는 공용 절차에 넘기기만 하고(`apiGitStage` →
# `gitStageRoute`), 파이프라인은 그 절차가 연다. 허용 함수 이름을 손으로 나열하면
# **이 게이트가 막으려는 바로 그 드리프트를 이 게이트가 겪는다** — 새 공용 절차가
# 생길 때마다 목록에 넣어야 하고, 넣지 않으면 조용히 거짓 실패가 된다.
posts=$(grep -oE '\{http\.MethodPost, [^,]+, \(\*GitServer\)\.[A-Za-z0-9_]+' "$DIR/routes.go" \
         | sed -E 's/.*\(\*GitServer\)\.//' | sort -u)

# body_of 는 메서드 하나의 본문이다 (그 func 부터 최상위 닫는 괄호까지).
body_of() {
  awk -v name="$1" '
    $0 ~ "^func \\(s \\*GitServer\\) " name "\\(" {inside=1}
    inside {print}
    inside && /^}$/ {exit}
  ' "$DIR"/*.go
}

# opens_pipeline 은 이 메서드가 파이프라인에 닿는지다. 위임은 한 단계 따라간다 —
# 라우팅 → 얇은 핸들러 → 공용 절차가 이 표면의 실제 깊이다.
opens_pipeline() {
  local body; body=$(body_of "$1")
  [[ -z "$body" ]] && return 0
  grep -qE 'beginWrite\(|beginServiceWrite\(' <<<"$body" && return 0
  local callee
  for callee in $(grep -oE '\ss\.[a-z][A-Za-z0-9_]*\(w, r' <<<"$body" | sed -E 's/.*s\.//;s/\(w, r//'); do
    grep -qE 'beginWrite\(|beginServiceWrite\(' <<<"$(body_of "$callee")" && return 0
  done
  return 1
}

# 저장소를 **범위로 갖지 않는** 쓰기. 파이프라인의 첫 단계가 repo 해석인데,
# 이들에게는 해석할 저장소가 없다 — `init` 은 저장소를 만드는 중이고, 핀 셋은
# workspace.json 의 목록을 편집한다 (저장소를 건드리지 않는다).
NOT_REPO_SCOPED='^(apiGitInit|apiGitPin|apiGitUnpin|apiGitReorder)$'

missing=""
for h in $posts; do
  [[ "$h" =~ $NOT_REPO_SCOPED ]] && continue
  opens_pipeline "$h" || missing+="     $h"$'\n'
done

if [[ -n "$missing" ]]; then
  echo "❌ POST 핸들러가 gitWrite 파이프라인을 열지 않습니다:"
  printf '%s' "$missing"
  echo "     → s.beginWrite(...) 또는 s.beginServiceWrite(...) 로 여십시오."
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "✓ git 쓰기가 전부 gitWrite 파이프라인을 지난다 (V-4 통과)"
fi
exit $fail
