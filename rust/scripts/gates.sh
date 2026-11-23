#!/usr/bin/env bash
#
# Rust 포팅의 CI 게이트 (RUST_PORT_SRS NFR-RSP-1·4·5). 한 곳에서 다 돈다.
#
#   1. cargo fmt --check
#   2. 다섯 대상 clippy -D warnings (scripts/cross-check.sh)
#   3. cargo deny check (라이선스·금지 crate·출처·권고, deny.toml)
#   4. cargo audit (RustSec 권고)
#   5. [--test] 격리 cargo test --workspace (scripts/hermetic.sh)
#   6. [--go]   Go 쪽 `make gates` — rust-port 브랜치도 문서·생성물 검사를 지나야 한다
#
# 사용: rust/scripts/gates.sh [--test] [--go]
set -euo pipefail
cd "$(dirname "$0")/.."

RUN_TEST=0
RUN_GO=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --test) RUN_TEST=1; shift ;;
    --go) RUN_GO=1; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done

for tool in cargo-deny cargo-audit; do
  command -v "$tool" >/dev/null || { echo "gates: $tool 이 없다 — cargo install $tool" >&2; exit 2; }
done

step() { echo; echo "══ $*"; }

step "fmt"
cargo fmt --all --check

step "clippy — 다섯 대상"
scripts/cross-check.sh

step "cargo deny"
cargo deny check

step "cargo audit"
cargo audit

if [[ "$RUN_TEST" == 1 ]]; then
  step "cargo test (격리)"
  scripts/hermetic.sh cargo test --workspace
fi

if [[ "$RUN_GO" == 1 ]]; then
  step "Go make gates (격리)"
  # 프런트 검사 몇이 espree 등 npm 개발 의존을 읽는다.
  [[ -d ../node_modules ]] || { echo "gates: node_modules 가 없다 — 저장소 루트에서 npm ci --ignore-scripts" >&2; exit 2; }
  scripts/hermetic.sh make -C .. gates
fi

echo
echo "gates: 통과"
