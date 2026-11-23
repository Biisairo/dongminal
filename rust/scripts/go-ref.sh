#!/usr/bin/env bash
# Go 참조 빌드 (GO_REMOVAL_SRS Q-GRM-4). Go 대조 시험만 쓰는 선택 실행이다.
#
#   DM_GO_REF_SRC=<main 의 worktree> rust/scripts/go-ref.sh <출력 경로> <패키지> [go build 인자...]
#
# <패키지> 가 `rust/` 로 시작하면 이 저장소의 Go 시험 프로그램(`rust/crates/**/testdata/go*`)이다.
# 그 .go 파일을 `-overlay` 로 DM_GO_REF_SRC 트리 안에 있는 것처럼 얹어 빌드한다. 트리에는 아무것도
# 쓰지 않는다. 그 밖의 값(`./cmd/dongminal`)은 DM_GO_REF_SRC 트리의 패키지다.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "사용: DM_GO_REF_SRC=<main 의 worktree> $0 <출력 경로> <패키지> [go build 인자...]" >&2
  exit 2
fi
out=$1 pkg=$2
shift 2

if [[ -z "${DM_GO_REF_SRC:-}" ]]; then
  echo "go-ref: Go 참조가 없다 — DM_GO_REF_SRC 에 main 의 worktree 경로를 준다" >&2
  exit 2
fi
src=$(cd "$DM_GO_REF_SRC" && pwd -P)
if [[ ! -f "$src/go.mod" ]]; then
  echo "go-ref: $src 에 go.mod 가 없다 — Go 기준선 트리가 아니다" >&2
  exit 2
fi
if ! command -v go >/dev/null 2>&1; then
  echo "go-ref: go 가 PATH 에 없다" >&2
  exit 2
fi

mkdir -p "$(dirname "$out")"
out=$(cd "$(dirname "$out")" && pwd -P)/$(basename "$out")

if [[ "$pkg" != rust/* ]]; then
  cd "$src"
  exec go build "$@" -o "$out" "$pkg"
fi

repo=$(cd "$(dirname "$0")/../.." && pwd -P)
dir="$repo/${pkg%/}"
virt="_dmgoref/$(echo "${pkg%/}" | tr '/' '_')"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/dm-goref.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
{
  printf '{"Replace":{'
  sep=""
  for f in "$dir"/*.go; do
    [[ -e "$f" ]] || { echo "go-ref: $dir 에 .go 파일이 없다" >&2; exit 2; }
    printf '%s"%s/%s/%s":"%s"' "$sep" "$src" "$virt" "$(basename "$f")" "$f"
    sep=","
  done
  printf '}}'
} > "$tmp/overlay.json"
cd "$src"
go build -overlay "$tmp/overlay.json" "$@" -o "$out" "./$virt"
