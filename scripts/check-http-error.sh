#!/usr/bin/env bash
#
# 오류 응답의 단일 경로 (ERROR_CONTRACT_SRS FR-ERR-3 · M5 `G6-1`).
#
# 핵심 표면은 `http.Error` 를 직접 부르지 않는다. `httpErr` 을 지난다 — 거기서
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

  internal/webserver/ 의 비검사 Go 소스에 `http.Error(` 가 없어야 한다.

    http.Error(w, "bad request", 400)
      →  httpErr(w, "bad request", 400, apierr.CodeBadRequest)

  본문과 상태는 바뀌지 않는다 — 코드는 X-Error-Code 헤더로 간다.

  지나가는 것: httperr.go (계층 자신) · *_test.go
USAGE
  exit 0
fi

# **주석은 지나간다.** 사실을 서술한 문장에서 그 이름을 지우면 근거가 사라진다 —
# `check-agent-names.sh` 가 같은 규칙을 쓴다. 재는 것은 실행 코드다.
hits=$(
  grep -rn 'http\.Error(' --include='*.go' --exclude='*_test.go' internal 2>/dev/null \
    | grep -v '^internal/webserver/httpapi/httperr\.go:' \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)'
)

if [[ -n "$hits" ]]; then
  echo "http.Error 를 직접 부르는 자리가 있습니다 (FR-ERR-3):"
  echo "$hits"
  echo
  echo "httpErr 로 옮기세요 — 본문은 그대로이고 X-Error-Code 가 붙습니다."
  exit 1
fi

# ── M8_UNIFIED_SRS FR-B-8 / TC-B-6 — 한국어 본문 ──
#
# `http.Error` 의 한국어는 M5 가 0 으로 만들었다. `httpErr` 의 한국어 본문은 D-ERR-2
# (본문은 공개 계약, 한 바이트도 바꾸지 않는다)로 **동결**됐고, 문장의 소유는 프론트
# 카탈로그(`err.<code>`)로 넘어갔다 (D-B-3). 그래서 여기서 재는 것은 둘이다 —
# `http.Error` 한국어 0, 그리고 `httpErr` 한국어 본문이 동결 목록(9곳)을 **넘지 않음**.
# 목록은 줄어들 수 있다(호출부가 사라지면). 늘면 새 한국어 본문이고, 그것은 카탈로그의 일이다.
FROZEN_HTTPERR_KO=9

ko_http_error=$(
  grep -rn 'http\.Error(' --include='*.go' --exclude='*_test.go' internal 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' \
    | grep '[가-힣]' || true
)
if [[ -n "$ko_http_error" ]]; then
  echo "http.Error 에 한국어 본문이 있습니다 (TC-B-6):"
  echo "$ko_http_error"
  exit 1
fi

ko_httperr=$(
  grep -rn 'httpErrf\?(' --include='*.go' --exclude='*_test.go' internal 2>/dev/null \
    | grep -v '^internal/webserver/httpapi/httperr\.go:' \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' \
    | grep '[가-힣]' || true
)
n_ko=$(printf '%s' "$ko_httperr" | grep -c . || true)
if (( n_ko > FROZEN_HTTPERR_KO )); then
  echo "httpErr 의 한국어 본문이 동결 목록($FROZEN_HTTPERR_KO)을 넘었습니다 ($n_ko) — FR-B-8:"
  echo "$ko_httperr"
  echo
  echo "새 오류 문장은 서버 본문이 아니라 프론트 카탈로그(web/js/i18n, err.<code>)의 것입니다."
  echo "본문은 영어 코드 서술로 두고 apierr 코드를 붙이세요."
  exit 1
fi

echo "http-error ok — 직접 호출 0곳 · 한국어 본문 $n_ko/$FROZEN_HTTPERR_KO (동결)"
