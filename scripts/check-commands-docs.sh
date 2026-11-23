#!/usr/bin/env bash
#
# `commands.md` ↔ `dmctl/mod.rs` 양방향 대조 (M5 `DOC-2`, GO_REMOVAL_SRS G-27).
#
# 착수 시 `commands.md` 가 `dmctl` 서브커맨드의 **절반 가까이**를 문서화하지
# 않고 있었다. 그리고 그 사실을 아무도 몰랐다 — 문서는 조용히 낡고, 낡았다는
# 것을 알려 주는 것이 없었기 때문이다.
#
# **양방향이다.** 없는 것을 안내하는 쪽도 결함이다 — 사용자는 그 명령을 치고
# `unknown command` 를 받는다.
#
# 사용: scripts/check-commands-docs.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DOC=docs/external/commands.md
SRC=rust/crates/helper/runtimebin/src/dmctl/mod.rs

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
dmctl 서브커맨드 문서 대조

  코드: dmctl/mod.rs 의 명령 표 command() 의 match 팔 (`"a" | "b" =>` 는 둘로 센다)
  문서: commands.md 표의 `| `dmctl <이름>` ...` 첫 칸

  둘의 집합이 같아야 한다. `help`/`-h`/`--help` 는 뺀다 — 명령이 아니라 출구다.
USAGE
  exit 0
fi

# ── 코드 쪽 ────────────────────────────────────────────────
code=$(
  {
    # 명령 표 한 벌 — `fn command` 의 `match name { … }` 팔 (REFACTOR3_GO_STRUCT_SRS FR-RGS-43).
    perl scripts/lib/rs-fn-body.pl command "$SRC" 2>/dev/null \
      | grep -E '^[[:space:]]*"[^"]+"([[:space:]]*\|[[:space:]]*"[^"]+")*[[:space:]]*=>' \
      | sed -E 's/=>.*//' | grep -oE '"[^"]+"' | tr -d '"'
  } | grep -vE '^(-h|--help|help)$' | LC_ALL=C sort -u
)
if [[ -z "$code" ]]; then
  echo "$SRC 의 명령 표에서 명령을 하나도 읽지 못했습니다 — 빈 통과를 막습니다."
  exit 1
fi

doc=$(
  grep -oE '^\| `dmctl [a-z-]+' "$DOC" | sed -E 's/^\| `dmctl //'
  # 같은 행 안의 `/ \`name\`` 꼴 곁가지.
  grep -E '^\| `dmctl ' "$DOC" | grep -oE '/ `[a-z-]+`' | tr -d '/ `'
)
doc=$(printf '%s\n' $doc | LC_ALL=C sort -u)

missing=$(comm -23 <(printf '%s\n' "$code") <(printf '%s\n' "$doc"))
extra=$(comm -13 <(printf '%s\n' "$code") <(printf '%s\n' "$doc"))

fail=0
if [[ -n "$missing" ]]; then
  echo "코드에 있는데 $DOC 에 없습니다:"
  printf '  dmctl %s\n' $missing
  fail=1
fi
if [[ -n "$extra" ]]; then
  echo "$DOC 에 있는데 코드에 없습니다:"
  printf '  dmctl %s\n' $extra
  echo "  (지웠다면 문서에서도 지우세요 — 없는 명령을 안내하면 사용자가 그것을 칩니다)"
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "commands-docs ok ($(printf '%s\n' "$code" | wc -l | tr -d ' ') 개)"
fi
exit $fail
