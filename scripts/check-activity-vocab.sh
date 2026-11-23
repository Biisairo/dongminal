#!/usr/bin/env bash
#
# 활동 상태 어휘의 두 벌 대조 (OPTIMIZE_REFACTOR_SRS FR-OPT-10-1 · SHR-14, GO_REMOVAL_SRS G-26).
#
# 어휘는 Rust 와 JS 에 한 벌씩 있다 — 서버가 싣는 낱말(`rust/crates/shared/activity`)과
# 화면이 읽는 낱말(`web/js/core/constants.js` 의 `ACTIVITY_STATE`). 한쪽에만 낱말이
# 늘거나 철자가 갈리면 카드가 상태를 잃는데, 그것은 어느 컴파일러도 잡지 못한다.
# 이 검사가 두 목록이 **같은 집합**인지 본다.
#
# 사용: scripts/check-activity-vocab.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

RS_SRC=rust/crates/shared/activity/src/lib.rs
JS_SRC=web/js/core/constants.js

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<USAGE
활동 상태 어휘 대조

  $RS_SRC 의 pub const 값과 $JS_SRC 의 ACTIVITY_STATE 값이 같은 집합인지 본다.
USAGE
  exit 0
fi

# Rust: `pub const NAME: &str = "value";` 줄.
rsVals=$(grep -hoE '^pub const [A-Z][A-Z0-9_]*: &(\x27static )?str = "[^"]+";' "$RS_SRC" 2>/dev/null \
  | grep -oE '"[^"]+"' | tr -d '"' | sort -u)
# JS: `const ACTIVITY_STATE=Object.freeze({KEY:'value',…});` 한 줄.
jsVals=$(grep -E '^const ACTIVITY_STATE=' "$JS_SRC" | grep -oE "[A-Z_]+:'[^']+'" | sed -E "s/^[A-Z_]+:'//; s/'$//" | sort -u)

# 아무것도 재지 않는 검사를 만들지 않는다 (check-home-layout.sh 와 같은 규약).
for side in rs js; do
  v=rsVals; src=$RS_SRC
  [[ $side == js ]] && { v=jsVals; src=$JS_SRC; }
  if [[ $(grep -c . <<<"${!v}") -lt 2 ]]; then
    echo "$src 에서 어휘를 $(grep -c . <<<"${!v}")개밖에 못 읽었다 — 검사가 공회전한다."
    exit 1
  fi
done

onlyRs=$(comm -23 <(echo "$rsVals") <(echo "$jsVals"))
onlyJs=$(comm -13 <(echo "$rsVals") <(echo "$jsVals"))
if [[ -n "$onlyRs$onlyJs" ]]; then
  echo "활동 상태 어휘가 Rust 와 JS 에서 갈린다 (FR-OPT-10-1):"
  [[ -n "$onlyRs" ]] && { echo "  $RS_SRC 에만 있다:"; sed 's/^/    /' <<<"$onlyRs"; }
  [[ -n "$onlyJs" ]] && { echo "  $JS_SRC 에만 있다:"; sed 's/^/    /' <<<"$onlyJs"; }
  exit 1
fi
echo "activity-vocab ok ($(grep -c . <<<"$rsVals")개 — Rust 와 JS 가 같다)"
