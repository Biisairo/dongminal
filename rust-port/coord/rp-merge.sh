#!/usr/bin/env bash
# 사용: rp-merge.sh <ref> <이슈ID> <메시지>   — rust-port 에 병합하고, Cargo.lock 충돌은 rust-port 쪽 기준으로 다시 채운 뒤, 그 이슈 crate 의 게이트를 돈다.
set -uo pipefail
ref=$1; id=$2; msg=$3
cd /Users/dykim/personal/dongminal-rust/int
if ! git merge -q --no-ff "$ref" -m "$msg" 2>/tmp/rp-merge.err; then
  conflicted=$(git diff --name-only --diff-filter=U)
  if [[ "$conflicted" == "rust/Cargo.lock" ]]; then
    git checkout --ours rust/Cargo.lock && (cd rust && cargo metadata -q --format-version 1 >/dev/null) && git add rust/Cargo.lock && git commit -q --no-edit || { echo "lock 해소 실패"; exit 1; }
  else
    echo "충돌: $conflicted"; cat /tmp/rp-merge.err; exit 1
  fi
fi
git log --oneline -1
echo "비 rust 변경: $(git diff --name-only HEAD^1 HEAD | grep -v '^rust/' | tr '\n' ' ')"
f=$(ls rust-port/issues/$id-*.md)
pk=()
for c in $(sed -n 's/^crates: \[\(.*\)\]/\1/p' "$f" | tr ',' ' '); do pk+=(-p "$c"); done
cd rust
cargo fmt --all --check || { echo FMT-FAIL; exit 1; }
cargo clippy -q "${pk[@]}" --all-targets -- -D warnings || { echo CLIPPY-FAIL; exit 1; }
scripts/hermetic.sh cargo test -q "${pk[@]}" 2>&1 | grep -E '^test result' | awk '{s+=$4; f+=$6} END {print "tests passed",s,"failed",f}'
scripts/prod-pids.sh
