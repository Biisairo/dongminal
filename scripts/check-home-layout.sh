#!/usr/bin/env bash
#
# 홈의 목록이 **전수인가** (STRUCTURE_CLEANUP_SRS FR-STR-36).
#
# `homeLayout()` 의 머리말이 스스로 적는다:
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
#   ② `homeLayout()` 의 Name
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

LAYOUT=internal/ctl/cli/homelayout.go

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<USAGE
홈 전수 목록 검사

  코드가 filepath.Join(<home|cfg.DataDir>, "…") 으로 만드는 첫 조각이
  전부 $LAYOUT 의 homeLayout() 에 있는지 본다.

  상수로 적힌 이름은 정의를 따라간다 (쓰는 파일 → 디렉터리 → 패키지).

  세 번째 집합은 docs/external/getting-started.md 의 "데이터가 어디 있나요" 표다.
  한 칸에 이름이 여럿이면(`a` · `b`) 나눠서 센다.

  --list  세 집합과 해석하지 못한 이름을 찍는다.
USAGE
  exit 0
fi

# decl <검색경로> <식별자> — 그 자리에서 상수 정의 한 줄을 찾아 값 또는 다음 이름을 낸다.
decl() {
  grep -rhoE "^[[:space:]]*(const[[:space:]]+)?$2[[:space:]]*=[[:space:]]*(\"[^\"]+\"|[A-Za-z_][A-Za-z0-9_.]*)[[:space:]]*(//.*)?$" \
    --include='*.go' "$1" 2>/dev/null | head -1 | sed -E 's/.*=[[:space:]]*//; s/[[:space:]]*\/\/.*//; s/[[:space:]]*$//'
}

# resolve <쓰는파일> <토큰> — `=값` 또는 `?토큰` 을 찍는다.
#
# 값에 `/` 나 `~` 가 있으면 **홈 항목의 이름이 아니다** — 홈 항목은 홈 바로 아래
# 한 칸이고 그 이름에 구분자가 없다. 그런 것은 해석 실패로 돌려 눈에 보이게 둔다
# (실측에서 `rollback.go` 의 `filepath.Join(home, target)` 이 그 자리였다 — 그
# `target` 은 런타임 값이고, 같은 디렉터리의 무관한 대입문이 잘못 걸렸다).
resolve() {
  local from="$1" tok="$2" hop v scope id
  for hop in 1 2 3; do
    if [[ "$tok" == \"* ]]; then
      v="${tok//\"/}"
      [[ "$v" == *"/"* || "$v" == "~"* ]] && { echo "?$2"; return; }
      echo "=$v"; return
    fi
    id="${tok##*.}"
    # 패키지 한정이면 그 이름의 디렉터리를 먼저 본다 — `FileName` 은 패키지마다 있다.
    if [[ "$tok" == *.* ]]; then
      scope=$(find internal cmd -type d -name "${tok%%.*}" 2>/dev/null | head -1)
    else
      scope="$from"
    fi
    v=""
    [[ -n "$scope" ]] && v=$(decl "$scope" "$id")
    [[ -z "$v" && "$tok" != *.* ]] && v=$(decl "$(dirname "$from")" "$id")
    [[ -z "$v" ]] && break
    tok="$v"
  done
  echo "?$2"
}

# ── 표 쪽: homeLayout() 의 Name ────────────────────────────────────────────
declared=$(
  grep -oE '\{Name:[[:space:]]*("[^"]+"|[A-Za-z_][A-Za-z0-9_.]*)' "$LAYOUT" | sed -E 's/\{Name:[[:space:]]*//' \
    | while read -r tok; do resolve "$LAYOUT" "$tok"; done | grep '^=' | cut -c2- | sort -u
)

# M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다.
if [[ $(grep -c . <<<"$declared") -lt 15 ]]; then
  echo "homeLayout() 에서 이름을 $(grep -c . <<<"$declared")개밖에 못 읽었다 — 검사가 공회전한다."
  exit 1
fi

# ── 코드 쪽: 홈 아래에 쓰는 첫 조각 ────────────────────────────────────────
#
# 홈을 담는 변수의 이름은 관례로 고정돼 있다 — `home`·`a.home`·`cfg.DataDir`.
# 넓히면 저장소 경로·임시 디렉터리가 섞여 들어와 이 검사가 "무엇이 홈인가" 를
# 스스로 흐린다.
sites=$(
  grep -rnoE 'filepath\.Join\((home|[a-z]\.home|cfg\.DataDir|opts\.DataDir)[[:space:]]*,[[:space:]]*("[^"]+"|[A-Za-z_][A-Za-z0-9_.]*)' \
    --include='*.go' --exclude='*_test.go' internal cmd 2>/dev/null
)
resolved=$(
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    f="${line%%:*}"
    tok="${line##*,}"; tok="${tok#"${tok%%[![:space:]]*}"}"
    printf '%s\t%s\n' "$f" "$(resolve "$f" "$tok")"
  done <<<"$sites"
)
used=$(grep -P '\t=' <<<"$resolved" 2>/dev/null | cut -f2 | cut -c2- | sort -u)
[[ -z "$used" ]] && used=$(awk -F'\t' '$2 ~ /^=/ {print substr($2,2)}' <<<"$resolved" | sort -u)
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
  echo "  $LAYOUT 의 표에 넣으세요 — What 과 Backup/Ephemeral 을 함께 정합니다."
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
