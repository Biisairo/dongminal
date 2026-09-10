#!/usr/bin/env bash
#
# 스크롤 소유권의 규약 (UI_LAYOUT_DEFAULTS_SRS FR-LAY-31).
#
# `.git-view` 의 기본이 실사용이다 — flex 열이고 **바깥은 구르지 않는다**
# (`overflow:hidden`). 안쪽 목록만 구른다. 그러므로 뷰별 `overflow`·`display`
# 재정의는 곧 **기본이 틀렸다는 신호**다.
#
# 이 검사가 없어서 생긴 일이 있다 (SRS §2.3). 여덟 뷰 중 둘이 재정의를
# `.git-view.git-<뷰>` 가 아니라 `.git-<뷰>` 로 적었고, 명시도 0-1-0 이
# `.git-view.vis`(0-2-0)에 **져서** `display:block` 으로 계산됐다. 그 결과
# 목록이 870px 이상 잘려 닿을 수 없었고, 항목이 적은 픽스처에서는 드러나지
# 않아 e2e 가 통과하고 있었다.
#
# 사용: scripts/check-scroll.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
스크롤 소유권 검사

  1) `.git-view.git-*` 에 overflow·display 재정의가 없다 — 기본이 옳으므로
     재정의는 기본이 틀렸다는 신호다 (FR-LAY-20·21).
  2) `.git-<뷰이름>` 형태로 뷰의 골격을 적은 규칙이 없다 — 명시도가 낮아
     `.git-view.vis` 에 진다 (FR-LAY-22 / SRS §2.3).

  뷰 이름의 진실은 web/js/core/constants-git.js 의 GIT_VIEWS 다.
USAGE
  exit 0
fi

CSS=(web/*.css)
VIEWS_SRC=web/js/core/constants-git.js
fail=0

# 뷰 이름을 **선언 한 자리**에서 얻는다 — 여기 다시 적으면 목록이 두 벌이 된다.
views=$(sed -n '/^const GIT_VIEWS=\[/,/^\];/p' "$VIEWS_SRC" | grep -o "key:'[a-z]*'" | sed "s/key:'//;s/'//")
if [[ -z "$views" ]]; then
  echo "✗ GIT_VIEWS 를 읽지 못했다 ($VIEWS_SRC)" >&2
  exit 1
fi

# (1) 뷰별 재정의
hits=$(grep -nE '\.git-view\.git-[a-z]+[^{]*\{[^}]*(overflow|display)' "${CSS[@]}" || true)
if [[ -n "$hits" ]]; then
  echo "✗ 뷰별 overflow·display 재정의가 있다 — 기본(.git-view)을 고쳐라 (FR-LAY-21)" >&2
  echo "$hits" >&2
  fail=1
fi

# (2) 명시도가 낮은 골격 규칙
for v in $views; do
  hits=$(grep -nE "(^|[,}])\.git-${v}\{" "${CSS[@]}" || true)
  if [[ -n "$hits" ]]; then
    echo "✗ .git-${v}{...} 는 .git-view.vis 에 진다 — 기본을 쓰거나 .git-view.git-${v} 로 적어라 (FR-LAY-22)" >&2
    echo "$hits" >&2
    fail=1
  fi
done

if [[ $fail -ne 0 ]]; then exit 1; fi
echo "✓ 스크롤 소유권 규약이 지켜진다 — 뷰 $(echo "$views" | wc -l | tr -d ' ')개에 재정의 0 (FR-LAY-31)"
