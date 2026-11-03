#!/usr/bin/env bash
#
# 옛 편집기 엔진의 이름이 남지 않았는가 (CODEMIRROR_MIGRATION_SRS FR-CMR-132 · §4.4).
#
# 엔진을 바꾼 뒤 남은 이름은 두 가지로 해롭다. 코드에서는 이미 없는 것을 가리켜
# 읽는 사람이 찾아 헤매고, 문서에서는 지금의 사실처럼 읽힌다. 그래서 이름이
# 남아도 되는 자리를 정해 두고, 그 밖에서는 하나도 허용하지 않는다.
#
# 패턴은 글자 하나를 괄호로 감싸 적는다 — 이 파일이 자기 자신에 걸리지 않는다.
#
# 사용: scripts/check-old-editor-name.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
옛 편집기 엔진 이름 검사

  `git grep -i` 로 엔진 이름을 찾는다. 다음 자리만 허용한다:
    CHANGELOG.md
    docs/internal/archive/
    docs/internal/CODEMIRROR_MIGRATION_SRS.md
    docs/internal/CODEMIRROR_MIGRATION_HANDOFF.md

  걸리면: 코드·유효한 문서는 지금 엔진의 말로 고치고, 끝난 문서는
  docs/internal/archive/ 로 옮긴다 (FR-CMR-132).
USAGE
  exit 0
fi

hits="$(git grep -il 'm[o]naco' -- . \
  ':!CHANGELOG.md' \
  ':!docs/internal/archive/' \
  ':!docs/internal/CODEMIRROR_MIGRATION_SRS.md' \
  ':!docs/internal/CODEMIRROR_MIGRATION_HANDOFF.md' || true)"

if [[ -n "$hits" ]]; then
  n="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
  echo "✗ 옛 편집기 엔진의 이름이 허용 자리 밖 ${n}개 파일에 남아 있습니다 (FR-CMR-132):"
  printf '  %s\n' $hits | head -40
  [[ "$n" -gt 40 ]] && echo "  … 외 $((n - 40))개"
  exit 1
fi

echo "✓ 옛 편집기 엔진 이름 없음 (FR-CMR-132)"
