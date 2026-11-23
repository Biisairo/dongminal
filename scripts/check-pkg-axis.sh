#!/usr/bin/env bash
#
# 프로세스 축 경계 · crate 표 검사 (M8 `GO-4` · `GO-48`, M8_UNIFIED_SRS §3.2 ①,
# GO_REMOVAL_SRS G-15).
#
# `rust/crates/` 는 **프로세스 축**으로 묶여 있다 (`architecture.md` §패키지 레이아웃) —
# `helper/`(①) · `daemon/`(②) · `webserver/`(③) · `ctl/`(④) 는 그 프로세스가
# 실행하는 것이고, 둘 이상이 실행하는 것만 `shared/` 다. 규칙은 둘이다:
#
#   1. 축 crate 는 **자기 축과 `shared/` 만** 의존한다.
#   2. `shared/` crate 는 **`shared/` 만** 의존한다.
#
# 의존은 `cargo metadata` 의 워크스페이스 경로 의존이다 (추이 의존 포함,
# dev-dependencies 제외 — Go 판 `go list -deps` 가 시험 import 를 세지 않은 것과 같다).
# 축 밖의 `gocompat/`(Go 기준선 출력 규칙)·`web/`(자산) 은 어느 축이든 쓴다.
# `cmd/`·`scripts/` 는 실행 진입점이라 축 crate 가 의존하면 위반이다.
#
# 감사(`01-go-arch.md` GO-4) 시점에 이 규칙이 네 곳에서 새어 있었고, 문서는
# "예외는 없다" 고 적혀 있었다 — 강제 장치가 없으면 규약은 선언으로 지켜지지
# 않는다 (`check-layer.sh` 와 같은 교훈). 남는 예외는 아래 ALLOW 에 **직접
# 의존 단위**로 적고 근거를 붙인다. 그 대상의 추이 의존까지 함께 허용된다.
#
# 세 번째 검사는 문서다: `architecture.md` 의 패키지 표가 워크스페이스 crate 와
# 양방향으로 같은가 (GO-48 — 감사 시점에 11개가 빠져 있었다).
#
# 사용: scripts/check-pkg-axis.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
프로세스 축 경계 · crate 표 검사

  scripts/check-pkg-axis.sh

  1. rust/crates/{helper,daemon,webserver,ctl}/** 는 자기 축과 rust/crates/shared/** 만
     의존한다 (추이 의존 포함, `cargo metadata`, dev-dependencies 제외).
  2. rust/crates/shared/** 는 rust/crates/shared/** 만 의존한다.
  3. docs/internal/architecture.md 의 패키지 표(코드 블록)가 워크스페이스 crate 와
     양방향으로 같다 — crate 가 표에 빠지지 않고, 표의 디렉터리가 실재한다.

예외는 이 스크립트의 ALLOW 에 "원천crate 대상crate" 한 쌍씩 적고 근거를 붙인다.
USAGE
  exit 0
fi

# 예외 등록부 — **직접 의존 한 쌍 단위다.** 축 crate 하나를 통째로 빼면 그
# crate 의 새 위반이 조용히 들어온다. 대상의 추이 의존은 함께 허용된다.
#
#   rust/crates/ctl/cli → rust/crates/webserver/domain/git/core
#     `verify` 가 저장소 루트를 git 으로 묻고(`RepoRoot`), `bundle` 이 원격 URL 의
#     자격증명을 지운다(`sanitize_remote`). 둘 다 이 저장소의 **유일한 규칙**이다 —
#     git 실행은 `domain/git` 만 한다는 규칙과 URL 마스킹 규칙 하나가 그것이다.
#     ④ 가 그 규칙을 우회해 자기 사본을 갖는 것이 더 나쁘다.
#   rust/crates/ctl/errdoc → rust/crates/webserver/apierr
#     오류 카탈로그 **생성기**다. 실행 주체는 ④ 프로세스가 아니라
#     `cargo run -p dm-scripts-gen-errors` 이고, 원천이 `apierr` 의 등록부이므로 그것을
#     읽지 않으면 생성물이 성립하지 않는다 (ERROR_CONTRACT_SRS 묶음 K).
ALLOW=(
  "rust/crates/ctl/cli rust/crates/webserver/domain/git/core"
  "rust/crates/ctl/errdoc rust/crates/webserver/apierr"
)

# 워크스페이스를 한 번 읽어 두 가지를 낸다 (경로는 저장소 뿌리 기준):
#   M <crate 디렉터리>          — 워크스페이스 crate 하나
#   D <원천 디렉터리> <대상 디렉터리> — 원천의 추이 의존 하나 (dev 제외, 자기 자신 제외)
meta_err=$(mktemp)
trap 'rm -f "$meta_err"' EXIT
meta=$(cd rust && cargo metadata --format-version 1 --locked 2>"$meta_err") || {
  echo "cargo metadata 가 실패했습니다:"
  sed 's/^/  /' "$meta_err"
  exit 1
}
graph=$(printf '%s' "$meta" | node -e '
  let s = "";
  process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const m = JSON.parse(s);
    const root = m.workspace_root.replace(/[\\/]rust$/, "");
    const ws = new Set(m.workspace_members);
    const dir = {};
    for (const p of m.packages) {
      if (!ws.has(p.id)) continue;
      dir[p.id] = p.manifest_path.slice(root.length + 1).replace(/\\/g, "/").replace(/\/Cargo\.toml$/, "");
    }
    const direct = {};
    for (const n of m.resolve.nodes) {
      if (!ws.has(n.id)) continue;
      direct[n.id] = n.deps.filter((d) => ws.has(d.pkg) && d.dep_kinds.some((k) => k.kind !== "dev")).map((d) => d.pkg);
    }
    const out = [];
    for (const id of Object.keys(dir)) {
      out.push("M " + dir[id]);
      const seen = new Set(), stack = [...(direct[id] || [])];
      while (stack.length) {
        const d = stack.pop();
        if (seen.has(d) || d === id) continue;
        seen.add(d);
        stack.push(...(direct[d] || []));
      }
      for (const d of seen) out.push("D " + dir[id] + " " + dir[d]);
    }
    console.log(out.sort().join("\n"));
  });
')
members=$(printf '%s\n' "$graph" | awk '$1 == "M" { print $2 }' | sort -u)
if [[ -z "$members" ]]; then
  echo "워크스페이스 crate 를 하나도 읽지 못했습니다 (rust/Cargo.toml) — 빈 통과를 막습니다."
  exit 1
fi

AX=rust/crates

axis_of() {
  # rust/crates/<axis>/... → <axis>
  local p="${1#"$AX"/}"
  echo "${p%%/*}"
}

deps_of() {
  printf '%s\n' "$graph" | awk -v s="$1" '$1 == "D" && $2 == s { print $3 }'
}

# 허용된 (원천, 대상) 쌍에서 대상 + 대상의 추이 의존을 모은다.
allowed_closure() {
  local src="$1" target
  for pair in "${ALLOW[@]}"; do
    [[ "${pair%% *}" == "$src" ]] || continue
    target="${pair##* }"
    echo "$target"
    deps_of "$target"
  done
}

fail=0
violations=()

while IFS= read -r crate; do
  axis=$(axis_of "$crate")
  case "$axis" in
    helper|daemon|webserver|ctl|shared) ;;
    *) continue ;;
  esac
  # 축 밖의 gocompat·web 은 누구나 쓴다. 그 밖의 대상(다른 축·cmd·scripts)만 본다.
  deps=$(deps_of "$crate" | grep -v -e "^$AX/gocompat\$" -e "^$AX/web\$" || true)
  if [[ "$axis" == "shared" ]]; then
    bad=$(printf '%s\n' "$deps" | grep -v "^$AX/shared/" | grep -v '^$' || true)
  else
    bad=$(printf '%s\n' "$deps" | grep -v "^$AX/shared/" | grep -v "^$AX/$axis/" | grep -v '^$' || true)
  fi
  [[ -n "$bad" ]] || continue
  allowed=$(allowed_closure "$crate" | sort -u)
  if [[ -n "$allowed" ]]; then
    bad=$(comm -23 <(printf '%s\n' "$bad" | sort -u) <(printf '%s\n' "$allowed") || true)
  fi
  [[ -n "$bad" ]] || continue
  while IFS= read -r d; do
    [[ -n "$d" ]] && violations+=("$crate -> $d")
  done <<<"$bad"
done <<<"$members"

if ((${#violations[@]})); then
  echo "프로세스 축을 넘는 import 가 있습니다 (${#violations[@]}곳):"
  printf '  %s\n' "${violations[@]}"
  echo
  echo "축 crate 는 자기 축과 rust/crates/shared/ 만, shared/ 는 shared/ 만 의존합니다."
  echo "공유해야 하는 것은 rust/crates/shared/ 로 내리고, 내릴 수 없는 이유가 있으면"
  echo "scripts/check-pkg-axis.sh 의 ALLOW 에 직접 의존 한 쌍과 근거를 적으세요."
  fail=1
fi

# ── 3. 패키지 표 ↔ 워크스페이스 crate ──

DOC=docs/internal/architecture.md

# 표는 "## 패키지 레이아웃" 아래 첫 코드 블록이다. 들여쓰기 2칸이 한 단계이고,
# 첫 토큰이 `/` 로 끝나는 줄만 디렉터리다 — 그 밖의 줄(파일·주석 이어짐)은
# 표의 설명이지 경로가 아니다.
table_dirs() {
  awk '
    /^## 패키지 레이아웃/ { sect=1; next }
    sect && /^```/ { if (inblock) exit; inblock=1; next }
    !inblock { next }
    {
      line=$0
      match(line, /^ */); indent=RLENGTH
      sub(/^ */, "", line)
      name=line; sub(/[ \t].*$/, "", name)
      if (name !~ /\/$/) next
      depth=int(indent/2)
      stack[depth]=name
      path=""
      for (i=0; i<=depth; i++) path=path stack[i]
      sub(/\/$/, "", path)
      print path
    }
  ' "$DOC"
}

doc_dirs=$(table_dirs | sort -u)
go_pkgs=$members

missing=$(comm -13 <(printf '%s\n' "$doc_dirs") <(printf '%s\n' "$go_pkgs"))
if [[ -n "$missing" ]]; then
  echo "architecture.md 패키지 표에 없는 crate ($(printf '%s\n' "$missing" | wc -l | tr -d ' ')개):"
  printf '  %s\n' $missing
  fail=1
fi

stale=""
while IFS= read -r d; do
  [[ -n "$d" && ! -d "$d" ]] && stale+="  $d"$'\n'
done <<<"$doc_dirs"
if [[ -n "$stale" ]]; then
  echo "architecture.md 패키지 표에 있으나 실재하지 않는 디렉터리:"
  printf '%s' "$stale"
  fail=1
fi

if ((fail)); then
  exit 1
fi

n_pkgs=$(printf '%s\n' "$go_pkgs" | wc -l | tr -d ' ')
echo "pkg-axis ok (축 위반 0 · 예외 ${#ALLOW[@]} · 표 ${n_pkgs}개 일치)"
