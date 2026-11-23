#!/usr/bin/env bash
#
# dongminal 빌드 (Rust 판). Go 판 `scripts/build.sh` 의 자리다. 사용법은 `-h` 참조.
set -euo pipefail
cd "$(dirname "$0")/.."

# 출력은 rust/dist 아래다. Go 판은 저장소 루트의 ./dongminal 에 썼지만, 그 자리는 운영 중인
# Go 바이너리일 수 있으므로 덮어쓰지 않는다.
BINARY="${BINARY:-dongminal}"
DIST="${DIST:-dist}"

# VERSION 은 바이너리에 새길 판이다. 비면 새기지 않고, 그때 값은 `dev` 다 — 소스 빌드와 릴리스
# 산출물을 구별하기 위해서다 (RELEASE_SRS FR-RVN-2/4, RUST_PORT_SRS FR-RSP-11).
VERSION="${VERSION:-}"

# 배포 대상. 교차 빌드의 툴체인·게이트는 8.3 이 맡는다.
TARGETS=(
  aarch64-apple-darwin
  x86_64-apple-darwin
  x86_64-unknown-linux-gnu
  aarch64-unknown-linux-gnu
  x86_64-pc-windows-msvc
)

usage() {
  cat <<EOF
dongminal 빌드 (Rust)

사용법:
  rust/scripts/build.sh                      호스트용 하나 → rust/$DIST/$BINARY
  rust/scripts/build.sh --target <triple>    대상 하나 → rust/$DIST/dongminal-<triple>[.exe]

옵션:
  --target <triple>  아래 배포 대상 중 하나
  -h, --help         이 도움말

배포 대상:
$(printf '  %s\n' "${TARGETS[@]}")

  windows 산출물만 .exe 확장자를 갖는다.

환경 변수:
  VERSION=v1.0.0   판을 새긴다 (DONGMINAL_BUILD_VERSION). 비면 dev
  BINARY, DIST     출력 이름·위치 (rust/ 기준)

새기는 값:
  · 판          DONGMINAL_BUILD_VERSION ← VERSION
  · 데몬 지문    DONGMINAL_BUILD_DAEMON ← rust/scripts/daemon-fingerprint.sh (대상마다)
                계산하지 못하면 비워 둔다 — 빈 것은 "모른다" 다 (FR-DFP-3)
EOF
}

die() { echo "$*" >&2; echo >&2; usage >&2; exit 1; }

# 재현 가능 빌드 (04-secops SEC-30): 빌드한 사람의 경로를 바이너리에서 지운다.
repro_rustflags() {
  local flags="${RUSTFLAGS:-}"
  flags="${flags:+$flags }--remap-path-prefix=$PWD=/dongminal/rust"
  [[ -n "${CARGO_HOME:-}" ]] && flags="$flags --remap-path-prefix=$CARGO_HOME=/cargo"
  flags="$flags --remap-path-prefix=$HOME/.cargo=/cargo"
  flags="$flags --remap-path-prefix=$(rustc --print sysroot)=/rustc"
  echo "$flags"
}

build_one() {
  local target="$1" out="$2"
  local fp; fp="$(scripts/daemon-fingerprint.sh --target "$target" 2>/dev/null || true)"
  local -a env=(RUSTFLAGS="$(repro_rustflags)")
  if [[ -n "$VERSION" ]]; then env+=(DONGMINAL_BUILD_VERSION="$VERSION"); fi
  if [[ -n "$fp" ]]; then env+=(DONGMINAL_BUILD_DAEMON="$fp"); fi
  env -u DONGMINAL_BUILD_VERSION -u DONGMINAL_BUILD_DAEMON "${env[@]}" \
    cargo build --release --locked -p dongminal --target "$target"
  local ext=""
  [[ "$target" == *windows* ]] && ext=".exe"
  mkdir -p "$(dirname "$out")"
  cp "target/$target/release/dongminal$ext" "$out"
  echo "  ✓ $out${fp:+ (daemon $fp)}"
}

TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ -n "${2:-}" ]] || die "--target 에 값이 없습니다"
      TARGET="$2"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      die "알 수 없는 옵션: $1" ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  host="$(rustc -vV | sed -n 's/^host: //p')"
  out="$DIST/$BINARY"
  build_one "$host" "$out"
  echo "빌드 완료: rust/$out"
  # FR-DFP-7: 방금 만든 것으로 재실행할 때 데몬을 갈아야 하는지 방금 만든 바이너리에게 묻는다.
  "./$out" health --daemon || true
else
  printf '%s\n' "${TARGETS[@]}" | grep -qx "$TARGET" \
    || die "지원하지 않는 대상입니다: $TARGET"
  ext=""
  [[ "$TARGET" == *windows* ]] && ext=".exe"
  build_one "$TARGET" "$DIST/dongminal-$TARGET$ext"
fi
