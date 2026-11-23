#!/usr/bin/env bash
#
# `api.md` ↔ 라우트 표 양방향 대조 (M5 `DOC-4`, GO_REMOVAL_SRS G-28).
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

  코드: {get,post,put,delete,patch,any,at}("...") + Matcher::{Under,UnderWith} + mux 의 Pattern::{Exact,Tree}("/api/...")
        (rust/crates/webserver/ 의 비검사 Rust 소스)
  문서: api.md 표의 `| METHOD | `/api/...` |`

  경로만 견준다 — 메서드까지 보면 같은 경로의 GET/PUT 을 한 행에 적은 문서가
  거짓 경보를 낸다. 재려는 것은 **그 표면이 문서에 있는가** 다.
USAGE
  exit 0
fi

# ── 코드 쪽 ────────────────────────────────────────────────
source scripts/lib/rs-src.sh
WS=rust/crates/webserver

# 라우트 등록 줄 (시험 전용 소스 제외). "<경로>:<줄>:<내용>" 에서 내용만 남긴다.
reg_lines() {
  grep -rnE "$1" "$WS" --include='*.rs' 2>/dev/null | rs_drop_tests | cut -d: -f3-
}

code=$(
  {
    # `get`·`post`·… 와 `any`. 메서드를 가르지 않는 `any` 도 표면이다. `at` 은 메서드를 직접 준다.
    # rustfmt 가 인자를 여러 줄로 나누므로 호출 단위로 읽는다.
    rs_src_files "$WS" | xargs perl scripts/lib/rs-calls.pl '(?<!\.)(?:get|post|put|delete|patch|any)' | rs_drop_tests \
      | sed -nE 's/^[^:]+:[0-9]+: [a-z]+\("(\/[^"]+)".*/\1/p'
    rs_src_files "$WS" | xargs perl scripts/lib/rs-calls.pl '(?<!\.)at' | rs_drop_tests \
      | sed -nE 's/^[^:]+:[0-9]+: at\("[A-Z]+", *"(\/[^"]+)".*/\1/p'
    # `when(…, Matcher::UnderWith("/api/tools/", "/busy"), …)` —
    # 경로 변수를 접두·접미로 가르는 형태다. 둘을 이어 붙이면 문서의
    # `/api/tools/<id>/busy` 와 같은 모양이 된다.
    reg_lines 'Matcher::UnderWith\(' \
      | grep -oE 'UnderWith\("[^"]+", *"[^"]+"\)' \
      | sed -E 's/UnderWith\("([^"]+)", *"([^"]+)"\)/\1\2/' | tr -s '/'
    # `Matcher::Under("/api/tools/")` — 접미가 없는 형태. 경로 변수가 끝에 온다.
    reg_lines 'Matcher::Under\("' \
      | grep -oE 'Matcher::Under\("[^"]+"' | grep -oE '"/[^"]+"' | tr -d '"' | sed -E 's#/$##'
    # 서버 mux 의 표 (Go `mux.HandleFunc`).
    reg_lines 'Pattern::(Exact|Tree)\("/api/' \
      | grep -oE 'Pattern::(Exact|Tree)\("/api/[^"]*"' | grep -oE '"/[^"]+"' | tr -d '"'
  } \
    | grep -E '^/api/' \
    | grep -v '^/api/$' \
    | LC_ALL=C sort -u
)
if [[ -z "$code" ]]; then
  echo "$WS 에서 라우트를 하나도 읽지 못했습니다 — 빈 통과를 막습니다."
  exit 1
fi

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
