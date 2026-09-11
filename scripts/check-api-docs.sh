#!/usr/bin/env bash
#
# `api.md` ↔ 라우트 표 양방향 대조 (M5 `DOC-4`).
#
# 착수 시 `api.md` 가 실제 HTTP 표면의 **절반 이상**을 빠뜨리고 있었다 —
# Git 60여 개와 Run 13개가 통째로. 문서가 절반만 적는 것보다 나쁜 것은,
# **그것이 절반인 줄 모르는 것**이다.
#
# **양방향이다.** 없는 종단을 안내하면 사용자는 404 를 받는다.
#
# 사용: scripts/check-api-docs.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DOC=docs/external/api.md

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
HTTP 표면 문서 대조

  코드: httproute.{Get,Post,Put,Delete,Patch}("...") + mux.HandleFunc("/api/...")
  문서: api.md 표의 `| METHOD | `/api/...` |`

  경로만 견준다 — 메서드까지 보면 같은 경로의 GET/PUT 을 한 행에 적은 문서가
  거짓 경보를 낸다. 재려는 것은 **그 표면이 문서에 있는가** 다.
USAGE
  exit 0
fi

# ── 코드 쪽 ────────────────────────────────────────────────
code=$(
  {
    # `Get`·`Post`·… 와 `Any`. 메서드를 가르지 않는 `Any` 도 표면이다.
    grep -rhoE 'httproute\.(Get|Post|Put|Delete|Patch|Any)\("[^"]+"' \
      internal/webserver --include='*.go' | grep -oE '"/[^"]+"' | tr -d '"'
    # `httproute.When(…, httproute.UnderWith("/api/tools/", "/busy"), …)` —
    # 경로 변수를 접두·접미로 가르는 형태다. 둘을 이어 붙이면 문서의
    # `/api/tools/<id>/busy` 와 같은 모양이 된다.
    grep -rhoE 'UnderWith\("[^"]+", *"[^"]+"\)' \
      internal/webserver --include='*.go' \
      | sed -E 's/UnderWith\("([^"]+)", *"([^"]+)"\)/\1\2/' | tr -s '/'
    # `Under("/api/tools/")` — 접미가 없는 형태. 경로 변수가 끝에 온다.
    grep -rhoE 'httproute\.Under\("[^"]+"' \
      internal/webserver --include='*.go' | grep -oE '"/[^"]+"' | tr -d '"' | sed -E 's#/$##'
    grep -rhoE 'mux\.HandleFunc\("/api/[^"]*"' \
      internal/webserver --include='*.go' | grep -oE '"/[^"]+"' | tr -d '"'
  } \
    | grep -E '^/api/' \
    | grep -v '^/api/$' \
    | LC_ALL=C sort -u
)

# ── 문서 쪽 ────────────────────────────────────────────────
# 표의 두 번째 칸에서 경로만 뽑는다. 질의문자열·경로 변수는 떼어 낸다 —
# 문서는 `?cols=&rows=` 를 적고 코드는 적지 않는다.
# **한 행이 둘을 소개하기도 한다** (`` `/api/git/stage` · `/api/git/unstage` ``).
# 첫 것만 읽으면 나머지가 통째로 미문서화로 셈된다.
doc=$(
  grep -E '^\| *(GET|POST|PUT|DELETE|PATCH|ANY) *\|' "$DOC" \
    | grep -oE '`/api/[^`]*`' | tr -d '`' \
    | sed -E 's/\?.*$//; s#/<[^>]*>##g; s#/$##' \
    | LC_ALL=C sort -u
)

missing=$(comm -23 <(printf '%s\n' "$code") <(printf '%s\n' "$doc"))
extra=$(comm -13 <(printf '%s\n' "$code") <(printf '%s\n' "$doc"))

fail=0
if [[ -n "$missing" ]]; then
  echo "코드에 있는데 $DOC 에 없습니다 ($(printf '%s\n' $missing | wc -l | tr -d ' ')개):"
  printf '  %s\n' $missing
  fail=1
fi
if [[ -n "$extra" ]]; then
  echo "$DOC 에 있는데 코드에 없습니다 ($(printf '%s\n' $extra | wc -l | tr -d ' ')개):"
  printf '  %s\n' $extra
  echo "  (지웠다면 문서에서도 지우세요 — 없는 종단을 안내하면 404 를 받습니다)"
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "api-docs ok ($(printf '%s\n' "$code" | wc -l | tr -d ' ') 개)"
fi
exit $fail
