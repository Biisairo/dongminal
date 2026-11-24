#!/usr/bin/env bash
#
# 배포 대상 다섯의 교차 검사 (RUST_PORT_SRS NFR-RSP-5). 호스트 하나에서 다섯 대상 모두
# `cargo clippy --workspace --all-targets -D warnings` 를 돈다.
#
# ring(rustls·rcgen·reqwest 의 암호 백엔드)은 C 를 컴파일하는 build.rs 를 가진다. 검사(check)는
# 링크하지 않으므로 C 는 **컴파일만** 되면 된다. 그래서 대상별 C 툴체인 없이 다음으로 돈다:
#   · C 컴파일러   clang (--target 은 cc 크레이트가 넣는다)
#   · 헤더         clang 내장 freestanding 헤더 + scripts/cross-check-include 의 최소 선언
#   · 아카이버     rustup llvm-tools 의 llvm-ar (MSVC 대상은 llvm-lib 이름으로 불러 lib 형식)
# 이렇게 만든 C 산출물은 쓸 수 없다 — 이 스크립트는 검사 게이트이지 빌드가 아니다. 실제 교차
# 빌드는 대상 OS 의 러너(또는 컨테이너, scripts/linux-test.sh)에서 한다.
#
# 사용: rust/scripts/cross-check.sh [<triple>...]   (비우면 다섯 대상 전부)
#       CROSS_CARGO=check 이면 clippy 대신 cargo check (scripts/check-cross.sh 의 build 단계)
set -euo pipefail
cd "$(dirname "$0")/.."

TARGETS=(
  aarch64-apple-darwin
  x86_64-apple-darwin
  x86_64-unknown-linux-gnu
  aarch64-unknown-linux-gnu
  x86_64-pc-windows-msvc
)
[[ $# -gt 0 ]] && TARGETS=("$@")

command -v clang >/dev/null || { echo "cross-check: clang 이 없다" >&2; exit 2; }
host="$(rustc -vV | sed -n 's/^host: //p')"
llvm_bin="$(rustc --print sysroot)/lib/rustlib/$host/bin"
if [[ ! -x "$llvm_bin/llvm-ar" ]]; then
  echo "cross-check: llvm-ar 가 없다 — rustup component add llvm-tools" >&2
  exit 2
fi
tools="$(mktemp -d "${TMPDIR:-/tmp}/otter-cross.XXXXXX")"
trap 'rm -rf "$tools"' EXIT
ln -s "$llvm_bin/llvm-ar" "$tools/llvm-ar"
ln -s "$llvm_bin/llvm-ar" "$tools/llvm-lib"
stub="$PWD/scripts/cross-check-include"

fail=0
for t in "${TARGETS[@]}"; do
  rustup target list --installed | grep -qx "$t" || rustup target add "$t"
  v="${t//-/_}"
  envs=()
  # macOS 호스트는 두 darwin 대상을 자기 툴체인으로 컴파일한다. 그 밖의 호스트(Linux 러너)는
  # darwin 대상도 clang 으로 돈다 — 시스템 cc(gcc)는 cc 크레이트가 넣는 `-arch` 를 모른다.
  if [[ "$t" != "$host" && ! ( "$t" == *apple-darwin && "$host" == *apple-darwin ) ]]; then
    ar="$tools/llvm-ar"
    [[ "$t" == *windows-msvc ]] && ar="$tools/llvm-lib"
    cflags="-ffreestanding -isystem $stub"
    # musl 대상에서 clang 의 stddef.h 는 시스템 헤더를 include_next 한다. 시스템 헤더가
    # 없으므로 내장 정의를 쓰게 한다 (검사 전용 — 산출물은 쓰지 않는다).
    [[ "$t" == *-musl ]] && cflags+=" -U__musl__"
    envs=("CC_$v=clang" "AR_$v=$ar" "CFLAGS_$v=$cflags")
  fi
  echo "── $t"
  if [[ "${CROSS_CARGO:-clippy}" == check ]]; then
    cmd=(cargo check --workspace --all-targets --keep-going --target "$t")
  else
    cmd=(cargo clippy --workspace --all-targets --keep-going --target "$t" -- -D warnings)
  fi
  if env ${envs[@]+"${envs[@]}"} "${cmd[@]}"; then
    echo "  ✓ $t"
  else
    echo "  ✗ $t"
    fail=1
  fi
done
exit "$fail"
