#!/usr/bin/env bash
#
# 활동 상태 어휘의 두 벌 대조 (OPTIMIZE_REFACTOR_SRS FR-OPT-10-1 · SHR-14).
#
# 어휘는 Go 와 JS 에 한 벌씩 있다 — 서버가 싣는 낱말(`internal/shared/activity`)과
# 화면이 읽는 낱말(`web/js/core/constants.js` 의 `ACTIVITY_STATE`). 한쪽에만 낱말이
# 늘거나 철자가 갈리면 카드가 상태를 잃는데, 그것은 어느 컴파일러도 잡지 못한다.
# 이 검사가 두 목록이 **같은 집합**인지 본다.
#
# 사용: scripts/check-activity-vocab.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

GO_SRC=internal/shared/activity/activity.go
JS_SRC=web/js/core/constants.js

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<USAGE
활동 상태 어휘 대조

  $GO_SRC 의 const 블록 값과 $JS_SRC 의 ACTIVITY_STATE 값이 같은 집합인지 본다.
USAGE
  exit 0
fi

# Go: const ( … ) 블록 안의 `Name = "value"` 줄.
goVals=$(awk '/^const \(/{inside=1; next} inside&&/^\)/{inside=0} inside' "$GO_SRC" \
  | grep -oE '^[[:space:]]*[A-Z][A-Za-z]*[[:space:]]*=[[:space:]]*"[^"]+"' | grep -oE '"[^"]+"' | tr -d '"' | sort -u)
# JS: `const ACTIVITY_STATE=Object.freeze({KEY:'value',…});` 한 줄.
jsVals=$(grep -E '^const ACTIVITY_STATE=' "$JS_SRC" | grep -oE "[A-Z_]+:'[^']+'" | sed -E "s/^[A-Z_]+:'//; s/'$//" | sort -u)

# 아무것도 재지 않는 검사를 만들지 않는다 (check-home-layout.sh 와 같은 규약).
for side in go js; do
  v=goVals; src=$GO_SRC
  [[ $side == js ]] && { v=jsVals; src=$JS_SRC; }
  if [[ $(grep -c . <<<"${!v}") -lt 2 ]]; then
    echo "$src 에서 어휘를 $(grep -c . <<<"${!v}")개밖에 못 읽었다 — 검사가 공회전한다."
    exit 1
  fi
done

onlyGo=$(comm -23 <(echo "$goVals") <(echo "$jsVals"))
onlyJs=$(comm -13 <(echo "$goVals") <(echo "$jsVals"))
if [[ -n "$onlyGo$onlyJs" ]]; then
  echo "활동 상태 어휘가 Go 와 JS 에서 갈린다 (FR-OPT-10-1):"
  [[ -n "$onlyGo" ]] && { echo "  $GO_SRC 에만 있다:"; sed 's/^/    /' <<<"$onlyGo"; }
  [[ -n "$onlyJs" ]] && { echo "  $JS_SRC 에만 있다:"; sed 's/^/    /' <<<"$onlyJs"; }
  exit 1
fi
echo "activity-vocab ok ($(grep -c . <<<"$goVals")개 — Go 와 JS 가 같다)"
