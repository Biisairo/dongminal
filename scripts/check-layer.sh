#!/usr/bin/env bash
#
# `ui/` · `git/` 이 App 의 **내부**를 파고들지 않는가 (M6 `FE-4` ·
# FE_MODULE_BOUNDARY_SRS FR-FMB-40~43).
#
# 착수 시 `app._xxx` 가 **363회 · 서로 다른 이름 148개**였다 (`02-fe-arch.md`
# FE-4). 대가는 하나다: **어느 것이 계약인지 말할 수 없다.**
# `architecture.md` 는 core/ui/git 을 디렉터리로 나눴지만, 언더스코어 메서드가
# 사실상 공개 API 였고 `renderer.js` 는 `app._drag`·`app._mPaneIdx` 같은
# **필드**까지 읽고 썼다. App 내부 이름 하나를 바꾸면 세 디렉터리가 깨지는데,
# 그것이 계약을 깬 것인지 남의 내부를 만지다 깨진 것인지 아무도 판정할 수 없다.
#
# 조치는 **승격**이었다 — 디렉터리를 넘는 이름에서 `_` 를 뗐다. 그 뒤로
# `app.x` 는 "그래도 된다고 적힌 것" 이고 `app._x` 는 "남의 내부" 다.
#
# 이 게이트가 그 구분이 다시 흐려지지 않게 한다. **값을 옮기는 것보다 다시
# 흩어지지 않게 하는 것이 본체다** (로드맵 §5-1 재발 방지 게이트).
#
# 사용: scripts/check-layer.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
프론트 계층 경계 검사

  web/js/ui · web/js/git 에서 `app._xxx` 를 쓰면 잡는다. App 의 `_` 이름은
  **core/ 안에서만** 쓴다.

    이전:  app._mPaneIdx
    지금:  app.mPaneIdx

  ui/ 나 git/ 이 App 의 새 내부에 닿아야 한다면, 그 이름을 **먼저 승격한다**
  (`_` 를 뗀다). 그 커밋이 "App 의 공개 표면이 하나 늘었다" 를 말한다.

  예외는 아래 ALLOW 에 **이름 단위**로 적고 근거를 붙인다.
USAGE
  exit 0
fi

# 예외 — **이름 단위다.** 파일을 통째로 빼면 그 파일의 새 위반이 조용히 들어온다.
#
# 지금은 비어 있다. 경계를 넘던 148개를 전부 승격했으므로 남은 자리가 없다.
ALLOW=()

hits=$(grep -rn --include='*.js' -E '\bapp\._[A-Za-z0-9_]' web/js/ui web/js/git || true)

if ((${#ALLOW[@]})); then
  for name in "${ALLOW[@]}"; do
    hits=$(printf '%s\n' "$hits" | grep -v "app\._${name}\b" || true)
  done
fi

hits=$(printf '%s\n' "$hits" | grep -v '^$' || true)

if [[ -n "$hits" ]]; then
  n=$(printf '%s\n' "$hits" | wc -l | tr -d ' ')
  echo "ui/·git/ 이 App 의 내부에 직접 닿습니다 (${n}곳):"
  printf '%s\n' "$hits" | sed 's/^/  /'
  echo
  echo '  그 이름이 계층을 넘어야 한다면 **먼저 승격하세요** (`_` 를 뗍니다).'
  echo '  FE_MODULE_BOUNDARY_SRS FR-FMB-40~43.' 
  exit 1
fi

echo "layer ok — ui/·git/ 의 App 내부 직접 접근 0곳"
exit 0
