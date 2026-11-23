#!/usr/bin/env bash
#
# 홈의 목록이 **전수인가** (STRUCTURE_CLEANUP_SRS FR-STR-36, GO_REMOVAL_SRS G-24).
#
# `home_layout()`(ctl/cli/src/homelayout.rs) 의 머리말이 스스로 적는다:
#
#   `backup` 이 담을 것과 `uninstall` 이 지울 것은 같은 물음의 두 답이다:
#   "무엇이 이 제품의 것인가". 두 벌로 적으면 한쪽만 고쳐지고, 그때 백업은 담지
#   않은 것을 제거는 지운다 — **되돌릴 수 없는 손실이다.**
#
# 그 위험이 그대로 실현돼 있었다. 표가 실제 홈의 절반쯤만 알았고, 그래서
# `git-worktrees/`(사용자 콘텐츠)는 `backup` 이 담지 않고 `ext/`(언어 서버,
# 수백 MB)는 `uninstall --purge` 가 "전부 지웠습니다" 하고 남겼다.
#
# **기존 검사가 왜 못 잡았나.** `homelayout_test.go` 는 `rollbackTargets` 와
# `homeLogs` 가 **표에 포함되는지만** 본다 — 둘 다 이미 표에 있는 것들이다.
# **표 밖에서 홈에 쓰는 코드가 있는지**는 아무도 묻지 않았다.
#
# 이 검사는 반대로 센다 — **코드가 홈 아래에 쓰는 첫 조각 전부**.
#
# ## 집합이 셋이다 (DOC_SYNC_SRS FR-DSY-50~52)
#
#   ① 코드가 홈에 쓰는 첫 조각
#   ② `home_layout()` 의 이름 (state·kept_dir·regen 의 첫 인자)
#   ③ `docs/external/getting-started.md` 의 "데이터가 어디 있나요" 표
#
#   이전 동작: ①↔② 둘만 봤다. ③ 은 B5 가 **손으로** 맞췄다
#   새  동작: ③ 도 양방향으로 본다
#   이유:     사용자가 읽는 것은 ③ 이다. 손으로 맞춘 것은 다음 변경에서 낡고,
#             그때 문서는 "이 폴더 밖에 상태를 두지 않습니다" 라고 단언한 채로
#             거짓이 된다 (`STRUCTURE_CLEANUP_SRS` §6-11 이 넘긴 자리)
#
# **물음은 여전히 하나다** — *"홈의 목록이 전수인가"*. 세 집합은 한 물음의 세
# 증인이다 (FR-DSY-52).
#
# ## 이름 해석
#
# 이름이 상수로 적힌 자리가 많다(`toolipc.DaemonBuildFile`·`platform.SocketFileName`).
# 그 값을 여기 두 번 적으면 그것이 이 검사가 막으려는 바로 그 모양이므로
# **정의를 따라간다.** 다만 `FileName` 같은 이름은 패키지마다 있어서, 해석은
# **쓰는 파일 → 그 디렉터리 → 이름이 가리키는 패키지 디렉터리** 순으로 좁혀서 한다.
#
# 해석하지 못한 이름은 **버리지 않고 찍는다** — 대개 표 자신을 도는 변수
# (`e.Name`)이고, 거기 진짜 상수가 섞이면 그 줄로 보인다.
#
# 사용: scripts/check-home-layout.sh [--list]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

LAYOUT=rust/crates/ctl/cli/src/homelayout.rs

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<USAGE
홈 전수 목록 검사

  코드가 <home|data_dir>.join("…") 또는 filepath::join(&[home, "…"]) 으로 만드는 첫 조각이
  전부 $LAYOUT 의 home_layout() 에 있는지 본다.

  상수로 적힌 이름은 정의를 따라간다 (쓰는 파일 → crate → use 로 들여온 crate).

  세 번째 집합은 docs/external/getting-started.md 의 "데이터가 어디 있나요" 표다.
  한 칸에 이름이 여럿이면(\`a\` · \`b\`) 나눠서 센다.

  --list  세 집합과 해석하지 못한 이름을 찍는다.
USAGE
  exit 0
fi

source scripts/lib/rs-src.sh

# 홈에 쓰지 않는 자리 — `경로|토큰`.
#
#   shared/edgenode/src/lib.rs — LEGACY_SPAWNS_FILE (peer-spawns.json)
#     옛 원격 기동 기록을 노드가 설 때 **지우는** 자리다 (FR-PDM-64). 홈에 쓰지 않는다.
#     Go 판은 `filepath.Join(o.Home, …)` 이라 이 게이트의 꼴에 걸리지 않았다.
NOT_WRITES=(
  "rust/crates/shared/edgenode/src/lib.rs|LEGACY_SPAWNS_FILE"
)

resolve_all() { perl scripts/lib/rs-const.pl rust/crates; }

if [[ ! -f "$LAYOUT" ]]; then
  echo "$LAYOUT 이 없다 — 검사가 공회전한다."
  exit 1
fi

layout_body=$(mktemp)
trap 'rm -f "$layout_body"' EXIT
perl scripts/lib/rs-fn-body.pl home_layout "$LAYOUT" >"$layout_body"
declared=$(
  perl scripts/lib/rs-calls.pl 'state|kept_dir|regen' "$layout_body" \
    | sed -E 's/^[^:]+:[0-9]+: [a-z_]+\(([^,]+),.*/\1/' \
    | while read -r tok; do printf '%s\t%s\n' "$LAYOUT" "$tok"; done \
    | resolve_all | awk -F'\t' '$2 ~ /^=/ {print substr($2, 2)}' | sort -u
)

if [[ $(grep -c . <<<"$declared") -lt 15 ]]; then
  echo "homeLayout() 에서 이름을 $(grep -c . <<<"$declared")개밖에 못 읽었다 — 검사가 공회전한다."
  exit 1
fi

sites=$(rs_src_files | xargs perl scripts/lib/rs-home-sites.pl | rs_drop_tests)
for nw in "${NOT_WRITES[@]}"; do
  sites=$(grep -vE "^${nw%%|*}:[0-9]+:${nw#*|}\$" <<<"$sites" || true)
done
resolved=$(
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    f="${line%%:*}"
    rest="${line#*:}"
    printf '%s\t%s\n' "$f" "${rest#*:}"
  done <<<"$sites" | resolve_all
)
used=$(awk -F'\t' '$2 ~ /^=/ {print substr($2,2)}' <<<"$resolved" | sort -u)
unresolved=$(awk -F'\t' '$2 ~ /^\?/ {print $1 " : " substr($2,2)}' <<<"$resolved" | sort -u)

missing=()
while IFS= read -r n; do
  [[ -z "$n" ]] && continue
  grep -qxF "$n" <<<"$declared" || missing+=("$n")
done <<<"$used"

# ── 문서 쪽: getting-started.md 의 "데이터가 어디 있나요" 표 ────────────────
#
# 첫 칸에서 백틱 안의 이름을 전부 집는다 — 한 칸에 여럿이 올 수 있다
# (`paned.sock` · `paned.pid` · `paned.build`). 디렉터리의 끝 `/` 는 뗀다:
# 표는 사람에게 디렉터리임을 보이려고 붙이고, `homeLayout()` 은 `IsDir` 로 답한다.
DOC=docs/external/getting-started.md
documented=$(
  awk '/^## 데이터가 어디 있나요/{inside=1} inside&&/^## /&&!/데이터가 어디 있나요/{inside=0} inside&&/^\|/{print}' "$DOC" \
    | sed -E 's/^\|([^|]*)\|.*/\1/' | grep -oE '`[^`]+`' | tr -d '`' | sed 's#/$##' | sort -u
)

if [[ $(grep -c . <<<"$documented") -lt 15 ]]; then
  echo "$DOC 의 홈 표에서 이름을 $(grep -c . <<<"$documented")개밖에 못 읽었다 — 검사가 공회전한다."
  exit 1
fi

docMissing=()   # 표에 있는데 문서에 없다
docExtra=()     # 문서에 있는데 표에 없다
while IFS= read -r n; do
  [[ -z "$n" ]] && continue
  grep -qxF "$n" <<<"$documented" || docMissing+=("$n")
done <<<"$declared"
while IFS= read -r n; do
  [[ -z "$n" ]] && continue
  grep -qxF "$n" <<<"$declared" || docExtra+=("$n")
done <<<"$documented"

if [[ "${1:-}" == "--list" ]]; then
  echo "표(homeLayout):"; sed 's/^/  /' <<<"$declared"
  echo "코드가 쓰는 첫 조각:"; sed 's/^/  /' <<<"$used"
  echo "문서($DOC):"; sed 's/^/  /' <<<"$documented"
  echo
fi

# FR-KIT-20c 와 같은 규약: **해석하지 못한 것의 수를 찍는다** — 범위가 조용히
# 좁아지는 것을 막는다.
if [[ -n "$unresolved" ]]; then
  echo "  해석하지 못한 이름 $(grep -c . <<<"$unresolved")자리 (대개 표 자신을 도는 변수이고, 진짜 상수가 섞이면 이 줄로 보인다):"
  sed 's/^/    /' <<<"$unresolved"
fi

if ((${#missing[@]})); then
  echo "홈에 쓰는데 homeLayout() 에 없는 항목이 있습니다 (FR-STR-30):"
  printf '  %s\n' "${missing[@]}"
  echo
  echo "  $LAYOUT 의 표에 넣으세요 — what 과 in_backup/ephemeral 을 함께 정합니다."
  echo "  표에 없으면 backup 이 담지 않고 uninstall --purge 가 지우지 않습니다."
  exit 1
fi

if ((${#docMissing[@]} + ${#docExtra[@]})); then
  echo "홈의 표와 문서가 어긋납니다 (FR-DSY-50·51):"
  if ((${#docMissing[@]})); then
    echo "  표에 있는데 $DOC 에 없다:"
    printf '    %s\n' "${docMissing[@]}"
  fi
  if ((${#docExtra[@]})); then
    echo "  $DOC 에 있는데 표에 없다:"
    printf '    %s\n' "${docExtra[@]}"
  fi
  echo
  echo "  사용자가 읽는 것은 문서입니다. 그 표가 \"이 폴더 밖에 상태를 두지 않습니다\" 라고"
  echo "  단언하므로, 빠진 이름 하나가 그 단언을 거짓으로 만듭니다."
  exit 1
fi

echo "home-layout ok (표 $(grep -c . <<<"$declared")개 · 코드가 쓰는 첫 조각 $(grep -c . <<<"$used")개 · 문서 $(grep -c . <<<"$documented")개 — 셋이 같다 · 해석 못 한 이름 $(grep -c . <<<"$unresolved"))"
