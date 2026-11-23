#!/usr/bin/env bash
#
# 오류 응답의 단일 경로 (ERROR_CONTRACT_SRS FR-ERR-3 · M5 `G6-1`, GO_REMOVAL_SRS G-19).
#
# 핵심 표면은 `httpresp::http_error` 를 직접 부르지 않는다. `http_err` 을 지난다 — 거기서
# `X-Error-Code` 가 붙는다.
#
# 왜: 착수 시 65곳이 `http.Error(w, "bad request", 400)` 이었다. 그 문자열은
# 사람이 읽는 말이지 클라이언트가 분기할 수 있는 것이 아니고, 같은 400 이 열 가지
# 이유로 났다. **본문은 그대로 두고** 코드를 헤더로 얹는 것이 이 게이트의 전부다.
#
# 사용: scripts/check-http-error.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
오류 응답의 단일 경로 검사

  rust/crates/ 의 비검사 Rust 소스에 `http_error(` 가 없어야 한다.

    httpresp::http_error(StatusCode::BAD_REQUEST, "bad request")
      →  http_err("bad request", StatusCode::BAD_REQUEST, apierr::CODE_BAD_REQUEST)

  본문과 상태는 바뀌지 않는다 — 코드는 X-Error-Code 헤더로 간다.

  지나가는 것: shared/httpresp/src/lib.rs (오류 응답의 한 문 — REFACTOR3_DEDUP_GO_SRS FR-RDG-2) ·
  시험 파일 · 스크립트의 HTTP_ERROR_ALLOW 에 근거와 함께 적은 자리
USAGE
  exit 0
fi

CALLS=scripts/lib/rs-calls.pl
TEST_FILE='(^|/)(tests/|tests\.rs$)'

# 제품 Rust 소스 (시험 파일 제외). 하나도 없으면 빈 통과를 막는다.
src_files() {
  find "$@" -name '*.rs' -not -path '*/target/*' 2>/dev/null | grep -vE "$TEST_FILE" | sort
}
all_src=$(src_files rust/crates)
if [[ -z "$all_src" ]]; then
  echo "검사할 Rust 소스가 없습니다 (rust/crates/**/*.rs) — 빈 통과를 막습니다."
  exit 1
fi

# Go 판에서 표준 라이브러리·의존이 직접 쓰던 평문 응답을 같은 바이트로 흉내 내는 자리다.
# Go 판의 제품 코드에는 `http.Error` 가 없었다 — 이 셋은 `http.NotFound`·`http.FileServer`·
# gorilla/websocket 업그레이더 안쪽의 `http.Error` 자리다.
HTTP_ERROR_ALLOW=(
  "rust/crates/webserver/httpapi/src/serve.rs"           # mux 의 404 page not found
  "rust/crates/webserver/httpapi/src/static_assets.rs"   # http.FileServer 의 404 page not found
  "rust/crates/webserver/httpapi/src/ws.rs"              # 업그레이드 거절 (gorilla/websocket)
)

# **주석은 지나간다.** 사실을 서술한 문장에서 그 이름을 지우면 근거가 사라진다 —
# `check-agent-names.sh` 가 같은 규칙을 쓴다. 재는 것은 실행 코드다.
all_http_error=$(printf '%s\n' "$all_src" | xargs perl "$CALLS" 'http_error' \
  | grep -v '^rust/crates/shared/httpresp/src/lib\.rs:' || true)
hits=$all_http_error
for f in "${HTTP_ERROR_ALLOW[@]}"; do
  hits=$(printf '%s\n' "$hits" | grep -vF "$f:" || true)
done

if [[ -n "$hits" ]]; then
  echo "http.Error 를 직접 부르는 자리가 있습니다 (FR-ERR-3):"
  echo "$hits"
  echo
  echo "http_err 로 옮기세요 — 본문은 그대로이고 X-Error-Code 가 붙습니다."
  exit 1
fi

# ── M8_UNIFIED_SRS FR-B-8 / TC-B-6 — 한국어 본문 ──
#
# `http.Error` 의 한국어는 M5 가 0 으로 만들었다. `http_err` 의 한국어 본문은 D-ERR-2
# (본문은 공개 계약, 한 바이트도 바꾸지 않는다)로 **동결**됐고, 문장의 소유는 프론트
# 카탈로그(`err.<code>`)로 넘어갔다 (D-B-3). 그래서 여기서 재는 것은 둘이다 —
# `http_error` 한국어 0, 그리고 `http_err` 한국어 본문이 동결 목록(9곳)을 **넘지 않음**.
# 목록은 줄어들 수 있다(호출부가 사라지면). 늘면 새 한국어 본문이고, 그것은 카탈로그의 일이다.
# 본문이 한국어 `const X: &str` 를 가리키면 그 호출도 센다.
FROZEN_HTTPERR_KO=9
HANGUL='[가-힣]'

ko_http_error=$(printf '%s\n' "$all_http_error" | grep "$HANGUL" || true)
if [[ -n "$ko_http_error" ]]; then
  echo "http.Error 에 한국어 본문이 있습니다 (TC-B-6):"
  echo "$ko_http_error"
  exit 1
fi

ko_consts=$(printf '%s\n' "$all_src" | xargs perl -CSD -0777 -ne 'print "$1\n" while /\bconst ([A-Z_][A-Z0-9_]*): &(?:\x27static )?str =\s*"[^"]*[\x{AC00}-\x{D7A3}]/g' \
  | sort -u | paste -sd'|' -)
ko_pat="$HANGUL"
[[ -n "$ko_consts" ]] && ko_pat="$HANGUL|\\b($ko_consts)\\b"
ko_httperr=$(printf '%s\n' "$all_src" | grep -v '^rust/crates/webserver/httpapi/src/httperr\.rs$' \
  | xargs perl "$CALLS" 'http_errf?' | grep -E "$ko_pat" || true)
n_ko=$(printf '%s' "$ko_httperr" | grep -c . || true)
if (( n_ko > FROZEN_HTTPERR_KO )); then
  echo "httpErr 의 한국어 본문이 동결 목록($FROZEN_HTTPERR_KO)을 넘었습니다 ($n_ko) — FR-B-8:"
  echo "$ko_httperr"
  echo
  echo "새 오류 문장은 서버 본문이 아니라 프론트 카탈로그(web/js/i18n, err.<code>)의 것입니다."
  echo "본문은 영어 코드 서술로 두고 apierr 코드를 붙이세요."
  exit 1
fi

# ── SAFETY_CORRECTNESS_SRS FR-SAF-22 — 방언 렌더러를 우회하는 오류 응답 ──
#
# 위의 `http_error` 검사는 **평문 표면**만 본다. JSON 방언 둘(git `{error,message}` ·
# fs `{code,message}`)은 `git_json`(gitapi)·`httpresp::json`(httpapi, Go 의 `fsJSON`)
# 으로 나가는데, 그 둘은 헤더를 세우지 않는다 — 세우는 것은 렌더러(`git_err_json`·
# `fs_fail`·`fail_code`)다.
#
# 착수 시 열둘이 그 렌더러를 우회해 오류 상태를 직접 썼다. 본문에 맥락을 더
# 실어야 해서 생긴 우회이고(충돌 응답이 "무엇이" 이미 있는지 말해야 한다),
# 하필 가장 자주 실패하는 경로였다 — `git_apply` 는 stage·unstage·discard·
# resolve·commit·undo 의 모든 실패를 지난다.
#
# 재는 것은 **성공이 아닌 상태로 `git_json`/`json` 을 직접 부르는가** 다.
# 렌더러는 이제 `httpresp::fail_*` 을 지나므로 지나가는 자리가 없다 (REFACTOR3_DEDUP_GO_SRS FR-RDG-2).
ok_status='StatusCode::(OK|CREATED|ACCEPTED|NO_CONTENT|PARTIAL_CONTENT)\b'

bypass=$(
  {
    src_files rust/crates/webserver/gitapi | xargs perl "$CALLS" 'git_json'
    src_files rust/crates/webserver/httpapi | xargs perl "$CALLS" '(?:httpresp::)?json'
  } | grep -vE "\\($ok_status" || true
)

if [[ -n "$bypass" ]]; then
  echo "오류 상태를 렌더러 없이 직접 쓴 자리가 있습니다 (FR-SAF-22 · FR-ERR-7):"
  echo "$bypass"
  echo
  echo "git_err_json(status, name, body) 를 쓰세요 — 본문은 그대로이고 X-Error-Code 가 붙습니다."
  echo "fs 표면은 fs_fail/fail_code 가 이미 헤더를 세웁니다."
  exit 1
fi

echo "http-error ok — 직접 호출 0곳 · 방언 우회 0곳 · 한국어 본문 $n_ko/$FROZEN_HTTPERR_KO (동결)"
