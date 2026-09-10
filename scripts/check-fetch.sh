#!/usr/bin/env bash
#
# 브라우저의 API 호출이 **한 겹을 지나는가** (CLIENT_API_SRS TC-CAPI-18·19).
#
# `web/js/core/api.js` 가 URL 조립·헤더·본문 읽기·실패 표현을 한 자리에서 한다.
# 그것을 지나지 않는 손수 `fetch` 가 하나라도 남으면 두 가지가 무너진다.
#
#   1. 상태 변경의 `Content-Type` — 게이트(FR-RQG-5)가 본문 없는 요청에도 JSON 을
#      요구한다. 종전에 여섯 자리가 그것을 빠뜨려 앱이 부팅되지 않았다.
#   2. M4 의 401 — 다룰 자리가 다시 흩어진다.
#
# 사용: scripts/check-fetch.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
브라우저 API 호출의 단일 경로 검사

  web/js 아래에서 `fetch(` 를 직접 부르는 자리를 찾는다. 허용되는 것은
  아래 둘뿐이며 그 목록은 CLIENT_API_SRS FR-CAPI-11 이 진실이다.

    web/js/core/api.js        전송 한 겹 자신
    web/js/core/timer-hub.js  주입 fetch(`ctx.fetch`) — 잡의 시한을 붙여 넘긴다

  새 호출은 apiGet/apiPost/apiPut/apiDel 을 쓴다.
USAGE
  exit 0
fi

# 허용 목록. 여기 이름을 더하는 것은 **결정**이며 SRS 를 함께 고쳐야 한다.
ALLOW='^web/js/core/api\.js:|^web/js/core/timer-hub\.js:'

# 주석 줄은 세지 않는다 — 옛 관용구를 근거로 적어 둔 자리가 있다.
hits="$(grep -rn 'fetch(' web/js --include='*.js' \
        | grep -vE "$ALLOW" \
        | grep -vE ':[0-9]+: *(\*|//)' \
        | grep -vE '(api|git)Fetch\(|_fetch\(' || true)"

if [[ -n "$hits" ]]; then
  echo "✗ 전송 겹을 지나지 않는 fetch 가 있습니다:"
  echo "$hits"
  echo
  echo "apiGet/apiPost/apiPut/apiDel 을 쓰세요 (docs/internal/CLIENT_API_SRS.md)."
  exit 1
fi

echo "✓ 브라우저의 API 호출이 전부 core/api.js 를 지난다"
