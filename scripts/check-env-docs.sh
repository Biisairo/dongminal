#!/usr/bin/env bash
#
# 환경변수 문서 대조 (CONFIG_MANAGEMENT_SRS FR-CFG-18 · M5 `G5-2`, GO_REMOVAL_SRS G-25).
#
# 코드가 읽는 환경변수와 `docs/external/getting-started.md` 의 표가 **양방향으로**
# 같아야 한다.
#
# 이 검사가 없던 동안 다섯이 문서 밖에 있었다 — `DONGMINAL_ATTENTION_IDLE_MS`·
# `DONGMINAL_ATTENTION_BELL`·`DONGMINAL_CMD_RESULT_TIMEOUT_MS`·`DONGMINAL_URL_OPEN`·
# `DONGMINAL_SHELL`. 로드맵조차 그 수를 넷으로 세고 있었다(`DONGMINAL_SHELL` 누락).
#
# **문서는 조용히 낡는다.** 그래서 사람의 눈을 집행자로 두지 않는다 — 이것이
# M5 의 핵심 장치이고, 같은 형태가 `commands.md`·`api.md`·`shortcuts.md` 에도 선다.
#
# 사용: scripts/check-env-docs.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DOC=docs/external/getting-started.md

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
환경변수 문서 대조

  코드의 `DONGMINAL_*`(+ `PORT`)와 getting-started.md 의 표를 양방향 대조한다.

  세는 것: rust/crates/ 의 **비검사 Rust 소스**에 나오는 변수 이름
  빼는 것: 시험 전용 소스 (검사 전용 변수는 제품 표면이 아니다),
           빌드 각인 변수 DONGMINAL_BUILD_VERSION·DONGMINAL_BUILD_DAEMON
USAGE
  exit 0
fi

source scripts/lib/rs-src.sh

# 빌드 각인 변수 — 실행 중에 읽지 않는다. 빌드할 때 `option_env!` 가 바이너리에 새기는
# 값이며 Go 판 `-ldflags -X` 의 자리다 (GO_REMOVAL_SRS Q-GRM-11, RUST_PORT_SRS FR-RSP-11).
BUILD_STAMP='^(DONGMINAL_BUILD_VERSION|DONGMINAL_BUILD_DAEMON)$'

src=$(rs_src_files)
if [[ -z "$src" ]]; then
  echo "검사할 Rust 소스가 없습니다 (rust/crates/**/*.rs) — 빈 통과를 막습니다."
  exit 1
fi

code_vars=$(
  printf '%s\n' "$src" | xargs grep -hoE '"DONGMINAL_[A-Z0-9_]+"' 2>/dev/null \
    | tr -d '"' | grep -vE "$BUILD_STAMP" | sort -u
)
if printf '%s\n' "$src" | xargs grep -qE 'const ENV_PORT[A-Z_]*: &(\x27static )?str = "PORT"' 2>/dev/null; then
  code_vars=$(printf '%s\nPORT\n' "$code_vars" | sort -u)
fi
if grep -qE '\$\{?BINARY' scripts/build.sh 2>/dev/null; then
  code_vars=$(printf '%s\nBINARY\n' "$code_vars" | sort -u)
fi

doc_vars=$(
  grep -oE '^\| `(DONGMINAL_[A-Z0-9_]+|PORT|BINARY)`' "$DOC" \
    | sed -E 's/^\| `//; s/`$//' | sort -u
)

missing=$(comm -23 <(printf '%s\n' "$code_vars") <(printf '%s\n' "$doc_vars"))
extra=$(comm -13 <(printf '%s\n' "$code_vars") <(printf '%s\n' "$doc_vars"))

fail=0
if [[ -n "$missing" ]]; then
  echo "코드에 있는데 $DOC 표에 없습니다:"
  printf '  %s\n' $missing
  fail=1
fi
if [[ -n "$extra" ]]; then
  echo "$DOC 표에 있는데 코드에 없습니다:"
  printf '  %s\n' $extra
  echo "  (이름을 지웠다면 표에서도 지우세요 — 없는 변수를 안내하면 안 됩니다)"
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "env-docs ok ($(printf '%s\n' "$code_vars" | wc -l | tr -d ' ') 개)"
fi
exit $fail
