#!/usr/bin/env bash
#
# Rust 포팅의 공급망·교차 게이트 (RUST_PORT_SRS NFR-RSP-1·4·5, GO_REMOVAL_SRS Q-GRM-12).
# fmt·clippy·build·test 는 저장소 루트의 `make gates`·`make test` 가 돈다.
#
#   1. 다섯 대상 clippy -D warnings (scripts/cross-check.sh)
#   2. cargo deny check (라이선스·금지 crate·출처·권고, deny.toml)
#   3. cargo audit (RustSec 권고)
#
# 사용: rust/scripts/gates.sh
set -euo pipefail
self="$(cd "$(dirname "$0")" && pwd -P)/$(basename "$0")"
cd "$(dirname "$0")/.."

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) sed -n '2,10p' "$self" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done

for tool in cargo-deny cargo-audit; do
  command -v "$tool" >/dev/null || { echo "gates: $tool 이 없다 — cargo install $tool" >&2; exit 2; }
done

step() { echo; echo "══ $*"; }

step "clippy — 다섯 대상"
scripts/cross-check.sh

step "cargo deny"
cargo deny check

step "cargo audit"
cargo audit

echo
echo "gates: 통과"
