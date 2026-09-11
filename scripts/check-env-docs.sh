#!/usr/bin/env bash
#
# 환경변수 문서 대조 (CONFIG_MANAGEMENT_SRS FR-CFG-18 · M5 `G5-2`).
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

  세는 것: internal/ · cmd/ 의 **비검사 Go 소스**에 나오는 변수 이름
  빼는 것: *_test.go (검사 전용 변수는 제품 표면이 아니다)
USAGE
  exit 0
fi

# ── 코드 쪽 ────────────────────────────────────────────────
# 검사 파일을 빼는 이유: `DONGMINAL_TEST_RUNS_DIR` 처럼 검사만 쓰는 변수는
# 제품의 표면이 아니다. 문서에 실으면 사용자가 쓸 수 있는 값으로 읽힌다.
code_vars=$(
  grep -rhoE '"DONGMINAL_[A-Z0-9_]+"' --include='*.go' internal cmd 2>/dev/null \
    --exclude='*_test.go' | tr -d '"' | sort -u
)
# `PORT` 는 접두사가 없어 따로 본다 — 이름이 계약이라 바꾸지 않는다.
if grep -rqE 'EnvPort\s*=\s*"PORT"' --include='*.go' internal 2>/dev/null; then
  code_vars=$(printf '%s\nPORT\n' "$code_vars" | sort -u)
fi
# 빌드 스크립트의 변수는 코드가 아니라 스크립트가 읽는다.
if grep -qE '\$\{?BINARY' scripts/build.sh 2>/dev/null; then
  code_vars=$(printf '%s\nBINARY\n' "$code_vars" | sort -u)
fi

# ── 문서 쪽 ────────────────────────────────────────────────
# 표의 첫 칸(`| \`VAR\` |`)만 센다. 본문에 스쳐 지나가는 언급은 문서화가 아니다.
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
