#!/usr/bin/env bash
#
# e2e 가 프론트의 **내부**를 직접 만지지 않는가 (M6 `TEST-6` ·
# APP_TESTING_CONTRACT_SRS FR-ATC-10~13).
#
# 착수 시 `app._xxx` 가 **507회 · 86파일 · 서로 다른 이름 114개**였다. 대가는
# 둘이었다:
#
#   ① 리팩터가 결함이 아니라 **이름 변경**으로 깨진다 — `_edWindows` 를 고치려면
#     33곳의 e2e 를 함께 열어야 하고, 그러면 그 리팩터의 diff 에서 "무엇이
#     바뀌었나" 가 보이지 않는다
#   ② e2e 가 **무엇을 계약으로 여기는지** 아무도 모른다
#
# 계약(`window.app.testing`)이 그 결합을 한 자리로 옮겼고, 이 게이트가 그것이
# 다시 흩어지지 않게 한다. **값을 옮기는 것보다 다시 흩어지지 않게 하는 것이
# 본체다** (로드맵 §5-1 재발 방지 게이트).
#
# 사용: scripts/check-e2e-private.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
e2e 의 프론트 내부 접근 검사

  e2e/ 안에서 `app._xxx` 를 직접 만지면 잡는다. 쓸 것은 `app.testing.xxx` 다.

    이전:  (window as any).app._edWindows
    지금:  (window as any).app.testing.edWindows

  계약에 없는 이름이 필요하면 **web/js/core/app-testing.js 를 먼저 고친다.**
  그 커밋이 "e2e 가 내부를 하나 더 보기 시작했다" 를 말한다.

  예외는 아래 ALLOW 에 **이름 단위**로 적고 근거를 붙인다 (FR-ATC-11·12).
USAGE
  exit 0
fi

# 예외 — **이름 단위다** (FR-ATC-12). 파일을 통째로 빼면 그 파일의 새 위반이
# 조용히 들어온다.
#
# 지금은 비어 있다. 계약이 137개 이름 전부를 덮으므로 예외가 필요한 자리가
# 없다 (FR-ATC-14: 덮지 않는 것은 `window.app` 의 존재 확인뿐이고 그것은
# `app._` 가 아니다).
ALLOW=()

# 세 꼴을 전부 잡는다. 처음 판은 첫 줄뿐이었고, 나머지 둘로 **352곳이 새어**
# 나갔다 (FE_MODULE_BOUNDARY_SRS §4.4a). 게이트가 재던 것이 실제와 달랐다:
#
#   app._x          직접
#   app?._x         옵셔널 체이닝 — `\bapp\._` 는 `?.` 를 넘지 못한다
#   const a=window.app; a._x   별칭 — 수신자 이름이 `app` 이 아니다
#
# 별칭은 **선언을 읽어** 찾는다. RHS 가 정확히 `window.app`/`(window as any).app`
# 인 것만 별칭으로 본다 — `const p=app.gitPanel` 의 `p` 는 App 이 아니다.
files=$(ls e2e/*.ts e2e/*.mts scripts/shots/*.ts 2>/dev/null || true)
hits=$(
  for f in $files; do
    grep -nE '(^|[^A-Za-z0-9_$.])(app)\s*(\?\.|\.)_[A-Za-z0-9_]' "$f" | sed "s|^|$f:|"
    grep -nE '\)\s*\.\s*app\s*(\?\.|\.)_[A-Za-z0-9_]' "$f" | sed "s|^|$f:|"
    for a in $(grep -oE '(const|let|var)[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*(:[[:space:]]*any)?[[:space:]]*=[[:space:]]*(\([[:space:]]*window[[:space:]]+as[[:space:]]+any[[:space:]]*\)|window)\.app[[:space:]]*[;,)]' "$f" \
              | sed -E 's/^(const|let|var)[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*).*/\2/' | sort -u); do
      [ "$a" = app ] && continue
      grep -nE "(^|[^A-Za-z0-9_\$.])${a}\s*(\?\.|\.)_[A-Za-z0-9_]" "$f" | sed "s|^|$f:|"
    done
  done | sort -u || true
)

if ((${#ALLOW[@]})); then
  for name in "${ALLOW[@]}"; do
    hits=$(printf '%s\n' "$hits" | grep -v "app\.${name}\b" || true)
  done
fi

hits=$(printf '%s\n' "$hits" | grep -v '^$' || true)

if [[ -n "$hits" ]]; then
  n=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
  echo "e2e 가 프론트 내부에 직접 닿습니다 (${n}곳):"
  printf '%s\n' "$hits" | sed 's/^/  /'
  echo
  echo "  쓸 것은 app.testing.<이름> 입니다 (APP_TESTING_CONTRACT_SRS FR-ATC-1)."
  echo "  계약에 없는 이름이면 web/js/core/app-testing.js 를 먼저 고치세요."
  exit 1
fi

names=$(grep -coE "^  '_" web/js/core/app-testing.js || true)
echo "e2e-private ok — 내부 직접 접근 0곳 (계약이 든 이름은 app-testing.js 가 셉니다)"
exit 0
