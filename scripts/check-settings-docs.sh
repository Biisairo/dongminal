#!/usr/bin/env bash
#
# **설정 화면에 있는 것이 사용자 문서에도 있는가** (DOC_SYNC_SRS FR-DSY-42).
#
# `CONTRIBUTING` 3-4 의 대조 표에는 `commands.md`·`api.md`·`shortcuts.md`·환경변수
# 넷이 있고 **설정 표면이 없었다.** 그래서 설정이 여섯 개 늘도록 아무도 몰랐다
# (`AUDIT-docs-gap.md` H4):
#
#   editorWordWrap · editorMinimap · tabFixedWidth · tabWidthPx ·
#   focusEdgeLevel · attnEdgeLevel
#
# 여섯 다 근거 SRS 가 있고 화면에도 있는데 **사용자 문서 어디에도 없었다.**
#
# 그런데 설정은 넷 중 **가장 대조하기 쉬운 표면**이다 — `settings-schema.js` 가
# 기계가 읽는 JSON 이고(`settingsschema.CheckShape()` 가 형태를 계약으로 강제한다)
# 그 안의 `where` 가 *"설정 화면의 어느 자리인가"* 를 이미 적는다.
#
# ## 무엇을 대조하는가
#
#   ① `where` 가 `Display ▸ X` 인 키  →  `features.md` §표시 설정 의 `**X**` 행
#   ② `where` 가 `Terminal ▸ X` 인 키 →  `features.md` §터미널 설정 의 `**X**` 행
#
# 반대 방향(문서에만 있는 행)은 **등록부로 둔다** — 브라우저에만 저장되는 설정이
# 정당하게 있고(표시 모드·모바일 기준 너비), 그것을 서버 블롭에서 찾을 수 없다.
# 새 행을 문서에만 더한 사람은 아래 `DOC_ONLY` 에 사유와 함께 적게 된다
# (`PERFORMANCE_HARDENING_SRS` D-PRF-2 의 꼴).
#
# ## `LC_ALL=C sort` 이어야 한다
#
# 이 검사가 세는 것은 **한국어 이름**이고, `en_US.UTF-8` 의 collation 아래에서
# `sort -u` 는 **서로 다른 이름을 같다고 본다** — 실측:
#
#   편집기 줄바꿈 · 편집기 미니맵 · 탭 너비 · 탭 너비 고정 ·
#   알림 가장자리 · 비활성 창 가장자리   →  `sort -u` 뒤 **여섯이 넷**
#
# 첫 판이 그래서 빠진 여섯 중 셋만 보고했다. `check-api-docs`·`check-commands-docs`·
# `check-vendor` 가 이미 `LC_ALL=C sort` 를 쓰고 있었다 — 같은 함정을 먼저 만난
# 자리다. 나머지 게이트들이 무사한 것은 **ASCII 만 정렬하기 때문**이고, 한국어를
# 세는 검사를 새로 만들 때는 이 한 줄이 필요하다.
#
# 사용: scripts/check-settings-docs.sh [--list]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

SCHEMA=web/js/core/settings-schema.js
DOC=docs/external/features.md

# 문서에만 있는 행 — **브라우저에 저장되는 설정**이라 서버 블롭에 없다.
# 사유 없이 늘어나지 않게 여기 이름으로 적는다.
DOC_ONLY=(
  "표시 모드"        # 뷰포트 기준 자동/강제. 기기마다 다르므로 브라우저에 남는다
  "모바일 기준 너비"  # 같음
)

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<USAGE
설정 ↔ 사용자 문서 대조

  $SCHEMA 의 where 가 "Display ▸ X"·"Terminal ▸ X" 인 키마다
  $DOC 의 해당 절에 **X** 행이 있는지 본다.

  문서에만 있는 행은 이 스크립트의 DOC_ONLY 에 사유와 함께 적는다 —
  브라우저에만 저장되는 설정이 정당하게 있기 때문이다.

  --list  양쪽 집합을 찍는다.
USAGE
  exit 0
fi

# 문서 절 하나에서 `| **항목** |` 의 항목 이름을 집는다.
docRows() {
  awk -v head="$1" '
    $0 ~ "^## " head {inside=1; next}
    inside && /^## / {inside=0}
    inside && /^\| \*\*/ {print}
  ' "$DOC" | sed -E 's/^\| \*\*([^*]+)\*\*.*/\1/'
}

# 스키마에서 `where` 가 그 구역인 항목 이름을 집는다.
schemaRows() {
  grep -oE "\"where\":\"$1 ▸ [^\"]*\"" "$SCHEMA" | sed -E "s/\"where\":\"$1 ▸ //; s/\"$//"
}

missing=()
extra=()
total=0

for sec in "Display:표시 설정" "Terminal:터미널 설정"; do
  key="${sec%%:*}"
  head="${sec##*:}"
  doc=$(docRows "$head" | LC_ALL=C sort -u)
  sch=$(schemaRows "$key" | LC_ALL=C sort -u)
  total=$((total + $(grep -c . <<<"$sch")))

  if [[ "${1:-}" == "--list" ]]; then
    echo "[$key] 스키마:"; sed 's/^/  /' <<<"$sch"
    echo "[$key] 문서:"; sed 's/^/  /' <<<"$doc"
    echo
  fi

  while IFS= read -r n; do
    [[ -z "$n" ]] && continue
    grep -qxF "$n" <<<"$doc" || missing+=("$key ▸ $n")
  done <<<"$sch"

  while IFS= read -r n; do
    [[ -z "$n" ]] && continue
    grep -qxF "$n" <<<"$sch" && continue
    allowed=0
    for a in "${DOC_ONLY[@]}"; do [[ "$n" == "$a" ]] && allowed=1 && break; done
    ((allowed)) || extra+=("$key ▸ $n")
  done <<<"$doc"
done

# M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다.
if [[ "$total" -lt 10 ]]; then
  echo "스키마에서 항목을 ${total}개밖에 못 읽었습니다 — 검사가 공회전합니다."
  exit 1
fi

[[ "${1:-}" == "--list" ]] && exit 0

fail=0
if ((${#missing[@]})); then
  echo "설정 화면에 있는데 $DOC 에 없습니다 (${#missing[@]}개):"
  printf '  %s\n' "${missing[@]}"
  echo
  echo "  $DOC 의 해당 절에 \`| **<이름>** | <설명> |\` 행을 더하세요."
  echo "  이름은 스키마의 where 와 **같은 글자**여야 합니다 — 다르면 사용자가"
  echo "  문서에서 찾은 말을 화면에서 찾지 못합니다."
  fail=1
fi
if ((${#extra[@]})); then
  echo "$DOC 에만 있고 스키마에 없습니다 (${#extra[@]}개):"
  printf '  %s\n' "${extra[@]}"
  echo
  echo "  브라우저에만 저장되는 설정이라면 이 스크립트의 DOC_ONLY 에 사유와 함께"
  echo "  적으세요. 그러지 않으면 서버 블롭에 없는 것이 있는 것처럼 읽힙니다."
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "settings-docs ok (설정 ${total}개 · 문서 전용 ${#DOC_ONLY[@]}개 — 양쪽이 같습니다)"
fi
exit $fail
