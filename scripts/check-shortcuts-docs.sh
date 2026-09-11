#!/usr/bin/env bash
#
# `shortcuts.md` ↔ `helpers.js` 양방향 대조 (M5 `DOC-3`).
#
# 착수 시 `sidebarToggle`·`edSave` 가 문서에 없었다. 조사에서 더 나왔다 —
# `edSave` 는 **라벨도 없었고**, 코드 탐색 셋(`edGotoDef`·`edFindRefs`·
# `edNavBack`)과 함께 **Settings 의 어느 그룹에도 없었다.** 화면에 뜨지 않으면
# 바꿀 수 없고, 그러면 문서 첫 줄의 "모든 앱 단축키는 커스터마이징 가능합니다"
# 가 거짓이 된다.
#
# 세 자리를 함께 본다 — 기본값 · 라벨 · 설정 화면의 그룹 · 문서.
#
# 사용: scripts/check-shortcuts-docs.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
단축키 문서·화면 대조

  SHORTCUT_DEFAULTS 의 모든 키가
    ① SHORTCUT_LABELS 에 라벨을 갖고
    ② _renderShortcutList 의 어느 그룹에 들어 있고
    ③ shortcuts.md 의 기본값 표에 그 라벨로 한 행을 갖는다.

  사이드바 탭 직행 키(`sbTab*`)는 뺀다 — 서술자에서 파생하므로 개수가 탭 수를 따른다.
USAGE
  exit 0
fi

exec node scripts/check-shortcuts-docs.mjs
