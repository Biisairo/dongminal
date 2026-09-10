#!/usr/bin/env bash
#
# 마크업에 값이 문자열로 끼어드는 자리를 잡는다
# (02-fe-arch 의 P0 · REQUEST_GATE_SRS 와 같은 계열의 "싱크에서 막는다").
#
# 규칙은 하나다 — **HTML 태그가 든 템플릿 리터럴 안의 `${…}` 는 반드시
# `escHtml(` 또는 `e(` 로 시작한다.**
#
# 예외를 두지 않는 것이 요점이다. "이 값은 서버가 준 것", "이건 숫자다",
# "여긴 마크업을 넣는 자리다" 같은 예외가 하나라도 있으면 다음 사람이 매번
# 판단해야 하고, 그 판단이 틀리는 날이 온다. 실제로 그랬다: 상태바가 터미널
# 출력을 그대로 그려서, 셸에서 도는 어떤 프로그램이든
#
#     printf '\e]777;Cwd;<img src=x onerror=…>\a'
#
# 한 줄로 웹 UI 문서 컨텍스트에서 JS 를 실행시킬 수 있었다. 이 UI 는 터미널·
# 파일·git 쓰기·설정 API 에 닿으므로 그것은 원격 코드 실행에 준한다.
#
# **마크업을 넣어야 하는 자리는 문자열로 잇지 말고 DOM 으로 세운다** —
# `document.createElement` + `appendChild`. 그 자리들은 이미 그렇게 고쳤다
# (`app-agents.js` 의 아이콘 버튼, `app-settings.js` 의 색 점,
# `app-tool.js` 의 확인창).
#
# 사용: scripts/check-html.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
마크업 보간 검사

  web/js 아래에서 "HTML 태그가 든 템플릿 리터럴 + ${…}" 을 찾아,
  그 보간이 escHtml(/e( 로 시작하지 않으면 위반으로 본다.

  고치는 길 둘:
    · 값을 넣는 자리면  ${escHtml(값)}
    · 마크업을 넣는 자리면  document.createElement 로 세운다
EOF
  exit 0
fi

# vendor 는 남의 코드다. 최소화된 번들이라 검사에 뜻이 없다.
hits="$(grep -rnE '`[^`]*<[a-zA-Z][^`]*\$\{' web/js --include='*.js' \
        | grep -v '/vendor/' \
        | grep -vE '\$\{(e|escHtml)\(' || true)"

if [[ -n "$hits" ]]; then
  echo "✗ 마크업에 이스케이프 없는 보간이 있다:"
  echo
  echo "$hits"
  echo
  echo "규칙: HTML 템플릿 안의 \${…} 는 escHtml( 또는 e( 로 시작해야 한다."
  echo "설계: docs/internal/production/02-fe-arch.md 의 P0"
  exit 1
fi

n="$(grep -rlE '`[^`]*<[a-zA-Z][^`]*\$\{' web/js --include='*.js' | grep -vc '/vendor/' || true)"
echo "✓ 마크업 보간이 전부 이스케이프를 지난다 (${n}개 파일)"
