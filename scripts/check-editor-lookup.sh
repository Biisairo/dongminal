#!/usr/bin/env bash
#
# 편집기 조회의 단일 경로 (REPO_FIX 03 §3A-6 · E-4).
#
# 편집기 Map 의 키는 `slotKey(id,slot)` 이다. 탭 id 로 `fileEditors.get(` 을 부르면
# 칸 0 만 잡혀, 칸 1 이상에만 있는 편집기의 닫기 확인·이름변경 추적·줄 이동이
# 조용히 빠진다 (#5, N6). 조회는 `editorsOf`·`editorAny`(app-slots.js)를 지난다.
#
# 사용: scripts/check-editor-lookup.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# 허용: 헬퍼 자신, 렌더러의 **정확한 칸 키** 등록·복원(그 칸의 인스턴스를 세우는 자리).
ALLOW='^web/js/core/app-slots\.js:|^web/js/ui/renderer-pane\.js:'

hits="$(grep -rn 'fileEditors\.get(' web/js \
        | grep -vE "$ALLOW" \
        | grep -vE ':[0-9]+: *(\*|//)' || true)"

if [[ -n "$hits" ]]; then
  echo "✗ 편집기를 헬퍼 밖에서 직접 조회합니다:"
  echo "$hits"
  echo
  echo "app.editorsOf(tabId) · app.editorAny(tabId) 를 쓰세요 (REPO_FIX 03 §3A-6)."
  exit 1
fi
echo "✓ 편집기 조회가 editorsOf·editorAny 를 지난다"
