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

echo "http-error ok — 직접 호출 0곳"
