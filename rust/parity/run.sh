#!/usr/bin/env bash
# 차분 실행 (RUST_PORT_SRS V-RSP-2, rust/parity/SPEC.md FR-PAR-41).
#
#   rust/parity/run.sh [--go-bin <경로>] [dm-parity 인자...]      Go 대 Rust
#   rust/parity/run.sh [--go-bin <경로>] --self-test              Go 대 Go 로 실행기 자체를 검증 (V-PAR-3)
#
# Go 참조는 --go-bin 으로 받은 바이너리다. 없으면 DM_GO_REF_SRC(main 의 worktree)에서
# rust/target/go-ref/dongminal 로 빌드한다. 둘 다 없으면 종료 2 (GO_REMOVAL_SRS G-65).
# 저장소 루트에는 만들지 않는다 (C-RSP-1).
set -euo pipefail

rust_dir=$(cd "$(dirname "$0")/.." && pwd -P)
repo=$(cd "$rust_dir/.." && pwd -P)
hermetic="$rust_dir/scripts/hermetic.sh"
go_bin="$rust_dir/target/go-ref/dongminal"
rust_bin="$rust_dir/target/debug/dongminal"
# 담당 이슈의 상태를 읽을 폴더. 이슈 worktree 의 사본은 낡을 수 있으므로 통합 worktree 를 줄 수 있다.
issues="${DM_PARITY_ISSUES:-$repo/rust-port/issues}"

case "${1:-}" in
  --go-bin)
    [[ $# -ge 2 ]] || { echo "parity: --go-bin 에 경로가 없다" >&2; exit 2; }
    go_bin=$2
    shift 2;;
  --go-bin=*)
    go_bin=${1#--go-bin=}
    shift;;
  *)
    if [[ -z "${DM_GO_REF_SRC:-}" ]]; then
      echo "parity: Go 참조가 없다 — --go-bin <경로> 나 DM_GO_REF_SRC=<main 의 worktree> 를 준다" >&2
      exit 2
    fi
    "$hermetic" "$rust_dir/scripts/go-ref.sh" "$go_bin" ./cmd/dongminal;;
esac
if [[ ! -x "$go_bin" ]]; then
  echo "parity: Go 참조 바이너리가 없다: $go_bin" >&2
  exit 2
fi
go_bin=$(cd "$(dirname "$go_bin")" && pwd -P)/$(basename "$go_bin")

if [[ "${1:-}" == "--self-test" ]]; then
  shift
  cd "$rust_dir"
  DM_PARITY_GO_BIN="$go_bin" exec "$hermetic" cargo test -p dm-parity "$@"
fi

(cd "$rust_dir" && "$hermetic" cargo build -p dongminal -p dm-parity)
exec "$hermetic" "$rust_dir/target/debug/dm-parity" --go "$go_bin" --rust "$rust_bin" --issues "$issues" "$@"
