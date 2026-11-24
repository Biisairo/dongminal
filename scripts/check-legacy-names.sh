#!/usr/bin/env bash
#
# 이름 변경 전의 옛 이름이 남지 않았는가 (OTTERMINAL_RENAME_SRS FR-REN-11).
#
# 옛 이름이 남을 수 있는 자리는 정해 둔다. 그 밖에서는 하나도 허용하지 않는다.
# 패턴은 글자 하나를 괄호로 감싸 적는다 — 이 파일이 자기 자신에 걸리지 않는다.
#
# 사용: scripts/check-legacy-names.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
옛 이름 검사

  옛 이름(전체 이름, 제어 명령 이름, 약칭 접두사)을 찾는다. 다음 자리만 허용한다:
    CHANGELOG.md, docs/internal/archive/, docs/internal/OTTERMINAL_RENAME_SRS.md
    Go 기준 자료(golden, testdata 의 Go 소스, gocompat/testdata)
    rust/crates/shared/otterenv/src/legacy.rs (코드의 옛 이름은 이 파일에만 둔다)
    rust/scripts/hermetic.sh, rust/scripts/prod-pids.sh (옛 판 운영 인스턴스 보호)
  줄 안에서는 기록 문서 경로(archive/...)와 저장소 폴더 경로를 허용한다.

  걸리면: 새 이름으로 고친다. 옛 이름이 꼭 필요한 코드는 legacy.rs 의 상수를 쓴다.
USAGE
  exit 0
fi

# 전체 이름은 대소문자를 가리지 않는다. 약칭은 가린다 — `DM-18` 같은 감사 항목 ID 는 옛 이름이 아니다.
pattern='[dD][oO][nN][gG][mM][iI][nN][aA][lL]|[dD][mM][cC][tT][lL]|(^|[^A-Za-z0-9])([d]m[_-][A-Za-z0-9]|[D]M_[A-Z0-9]|[d]m(env|log)([^a-z]|$))'

hits="$(git grep -n -I -E "$pattern" -- . \
  ':!CHANGELOG.md' \
  ':!docs/internal/archive/' \
  ':!docs/internal/OTTERMINAL_RENAME_SRS.md' \
  ':!rust/crates/ctl/cli/testdata/go_cli_golden.json' \
  ':!rust/crates/ctl/cli/testdata/go_cli_golden_home.json' \
  ':!rust/crates/webserver/httpapi/src/tests/go_golden_554.json' \
  ':!rust/crates/helper/runtimebin/testdata/*.golden' \
  ':!rust/**/testdata/**/*.go' \
  ':!rust/crates/gocompat/testdata/' \
  ':!rust/crates/shared/otterenv/src/legacy.rs' \
  ':!rust/scripts/hermetic.sh' \
  ':!rust/scripts/prod-pids.sh' \
  ':!scripts/check-legacy-names.sh' \
  | perl -ne '
      my ($loc, $text) = /^([^:]+:\d+):(.*)$/ or next;
      $text =~ s{archive/[^\s)`\x27"\]>,]*}{}g;
      $text =~ s{personal/[d]ongminal(?:/[d]ongminal)?(?![A-Za-z0-9_-])}{}g;
      $text =~ s{[d]ongminal-rust}{}g;
      next unless $text =~ /(?i:[d]ongminal|[d]mctl)|(?:^|[^A-Za-z0-9])(?:[d]m[_-][A-Za-z0-9]|[D]M_[A-Z0-9]|[d]m(?:env|log)(?![a-z]))/;
      print "$loc\n";
    ' || true)"

if [[ -n "$hits" ]]; then
  n="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
  echo "✗ 옛 이름이 허용 자리 밖 ${n}곳에 남아 있습니다 (FR-REN-11):"
  printf '%s\n' "$hits" | head -40 | sed 's/^/  /'
  [[ "$n" -gt 40 ]] && echo "  … 외 $((n - 40))곳"
  exit 1
fi

echo "✓ 옛 이름 없음 (FR-REN-11)"
