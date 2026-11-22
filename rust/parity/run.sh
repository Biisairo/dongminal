#!/usr/bin/env bash
# 차분 실행 (RUST_PORT_SRS V-RSP-2, rust/parity/SPEC.md FR-PAR-41).
#
#   rust/parity/run.sh [dm-parity 인자...]      Go 대 Rust
#   rust/parity/run.sh --self-test              Go 대 Go 로 실행기 자체를 검증 (V-PAR-3)
#
# Go 참조 바이너리는 rust/target/go-ref/dongminal 에 만든다. 저장소 루트에는 만들지 않는다 (C-RSP-1).
set -euo pipefail

rust_dir=$(cd "$(dirname "$0")/.." && pwd -P)
repo=$(cd "$rust_dir/.." && pwd -P)
hermetic="$rust_dir/scripts/hermetic.sh"
go_bin="$rust_dir/target/go-ref/dongminal"
rust_bin="$rust_dir/target/debug/dongminal"

(cd "$repo" && "$hermetic" go build -o "$go_bin" ./cmd/dongminal)

if [[ "${1:-}" == "--self-test" ]]; then
  shift
  cd "$rust_dir"
  DM_PARITY_GO_BIN="$go_bin" exec "$hermetic" cargo test -p dm-parity "$@"
fi

(cd "$rust_dir" && "$hermetic" cargo build -p dongminal -p dm-parity)
exec "$hermetic" "$rust_dir/target/debug/dm-parity" --go "$go_bin" --rust "$rust_bin" "$@"
