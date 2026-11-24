#!/usr/bin/env bash
#
# dongminal 빌드. 이 저장소의 유일한 빌드 스크립트다 — 나머지 운영 동작
# (start/stop/migrate/health)은 바이너리의 액션이다. 사용법은 `-h` 참조.
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"

BINARY="${BINARY:-dongminal}"
DIST="${DIST:-dist}"

# VERSION 은 바이너리에 새길 판이다. 비면 새기지 않고, 그때 값은 기본값 `dev` 다 —
# 소스 빌드와 릴리스 산출물을 구별하기 위해서다 (RELEASE_SRS FR-RVN-2/4,
# RUST_PORT_SRS FR-RSP-11). 릴리스 워크플로우가 태그 문자열을 그대로 넣는다.
VERSION="${VERSION:-}"

# TARGETS 는 --all 이 만드는 대상이자 -h 가 보여 주는 목록이다. 한 곳에만
# 적어 도움말이 실제 동작과 어긋나지 않게 한다.
TARGETS=(darwin/arm64 darwin/amd64 linux/amd64 linux/arm64 windows/amd64)

usage() {
  cat <<EOF
dongminal 빌드

사용법:
  scripts/build.sh                          호스트용 하나 → ./$BINARY
  scripts/build.sh --all                    배포 대상 전부 → $DIST/
  scripts/build.sh --os <os> [--arch <arch>] 대상 하나만 → $DIST/

옵션:
  --all              아래 대상 전부를 빌드한다
  --os <os>          darwin | linux | windows
  --arch <arch>      amd64 | arm64  (기본: amd64)
  -h, --help         이 도움말

배포 대상:
$(printf '  %s\n' "${TARGETS[@]}")

  WSL 은 별도 대상이 아니다 — linux/amd64 를 그대로 쓴다.
  windows 산출물만 .exe 확장자를 갖는다.

예:
  scripts/build.sh --os windows              # 맥에서 윈도우용 빌드
  scripts/build.sh --os linux --arch arm64
  BINARY=dm scripts/build.sh                 # 출력 이름 바꾸기
  DIST=out scripts/build.sh --all            # 출력 위치 바꾸기
  VERSION=v1.0.0 scripts/build.sh --all      # 판을 새겨서 빌드 (릴리스가 쓰는 형태)

참고:
  · Rust 워크스페이스(rust/)를 cargo build --release --locked 로 빌드한다.
  · 대상마다 rustup target 이 있어야 한다 (rustup target add <triple>).
      darwin/arm64  aarch64-apple-darwin       linux/amd64  x86_64-unknown-linux-musl
      darwin/amd64  x86_64-apple-darwin        linux/arm64  aarch64-unknown-linux-musl
      windows/amd64 x86_64-pc-windows-msvc
    linux 는 musl 정적 바이너리다. 호스트가 다른 대상은 교차 링커도 필요하다 —
    없으면 cargo 의 오류를 그대로 내고 실패한다.
  · 프론트엔드는 rust-embed 로 web/ 이 들어간다. npm 은 e2e(Playwright) 전용이다.

관련:
  scripts/check-cross.sh   대상 전량 build + vet
  scripts/check-seams.sh   OS 의존 호출이 platform 밖에 없는지
EOF
}

die() { echo "$*" >&2; echo >&2; usage >&2; exit 1; }

# triple_for 는 Go 이름의 대상을 rustc 대상으로 바꾼다 (GO_REMOVAL_SRS FR-GRM-2).
# linux 는 Go 판의 CGO_ENABLED=0 정적 바이너리와 같게 musl 이다 (Q-GRM-1).
triple_for() {
  case "$1" in
    darwin/arm64)  echo aarch64-apple-darwin ;;
    darwin/amd64)  echo x86_64-apple-darwin ;;
    linux/amd64)   echo x86_64-unknown-linux-musl ;;
    linux/arm64)   echo aarch64-unknown-linux-musl ;;
    windows/amd64) echo x86_64-pc-windows-msvc ;;
    *) return 1 ;;
  esac
}

# host_target 은 호스트의 "<os>/<arch> <triple>" 이다. 호스트 빌드는 rustc 의 호스트
# 대상을 그대로 쓴다 — 개발 기계에 musl 대상이 없어도 ./dongminal 이 나와야 한다.
host_target() {
  local triple os arch
  triple="$(cd rust && rustc -vV | sed -n 's/^host: //p')"
  case "$triple" in
    *-apple-darwin) os=darwin ;;
    *-linux-*)      os=linux ;;
    *-windows-*)    os=windows ;;
    *)              os="${triple#*-*-}" ;;
  esac
  case "$triple" in
    x86_64-*)  arch=amd64 ;;
    aarch64-*) arch=arm64 ;;
    *)         arch="${triple%%-*}" ;;
  esac
  echo "$os/$arch $triple"
}

# ── 재현 가능 빌드 ────────────────────────────────────
#
# Go 판 `-trimpath` 의 자리다 (04-secops SEC-30). 정의와 근거는 scripts/lib/repro-rustflags.sh
# 한 자리에 있다 — e2e/global-setup.ts 도 그것을 쓴다.
. scripts/lib/repro-rustflags.sh

# ── 데몬 지문 ─────────────────────────────────────────
#
# 같은 바이너리가 두 프로세스로 돈다 — 웹서버와 `dongminald`. `start` 는 앞의
# 것을 죽이고 새 바이너리로 뜨고, 데몬은 세션을 유지하며 교체한다
# (DAEMON_SESSION_KEEP_SRS). `--server-only` 나 교체를 모르는 옛 데몬이면 데몬은
# **옛 바이너리 그대로** 돈다. 그래서 빌드마다 물음이 하나 선다: 이번 것은 데몬을
# 갈아야 하는가.
#
# 답의 재료를 여기서 새긴다 (DAEMON_STALENESS_SRS FR-DFP-1). 계산은
# `daemon-fingerprint.sh` 한 자리에 있다 — 정의역이 두 벌이 되면 한쪽만 고쳐진다.
#
# 계산하지 못하면 **비워 둔다**. 빈 것은 "모른다" 이지 일치가 아니다 (FR-DFP-3) —
# 거짓 값을 새기면 그 뒤의 판정이 전부 거짓이 된다.
daemon_fp() {
  scripts/daemon-fingerprint.sh --os "$1" --arch "$2" 2>/dev/null || true
}

build_one() {
  local os="$1" arch="$2" triple="$3" out="$4"
  local fp; fp="$(daemon_fp "$os" "$arch")"
  local -a env=(RUSTFLAGS="$(repro_rustflags "$triple")")
  # linux musl: ring 의 C 코드를 musl 로 컴파일한다. musl-tools(musl-gcc)가 있는 같은
  # 아키텍처의 linux 호스트에서 원생 빌드한다 (Q-GRM-2). CC_<대상> 을 주면 그것을 쓴다.
  local ccvar="CC_${triple//-/_}"
  if [[ "$triple" == *-linux-musl && -z "${!ccvar:-}" ]] && command -v musl-gcc >/dev/null; then
    env+=("$ccvar=musl-gcc")
  fi
  [[ -n "$VERSION" ]] && env+=(DONGMINAL_BUILD_VERSION="$VERSION")
  [[ -n "$fp" ]] && env+=(DONGMINAL_BUILD_DAEMON="$fp")
  # 바깥 환경의 각인 변수는 쓰지 않는다 — 새기는 값은 VERSION 과 지문뿐이다 (FR-GRM-4).
  (cd rust && env -u DONGMINAL_BUILD_VERSION -u DONGMINAL_BUILD_DAEMON "${env[@]}" \
    cargo build --quiet --release --locked -p dongminal --target "$triple")
  local tdir="${CARGO_TARGET_DIR:-target}"
  [[ "$tdir" == /* ]] || tdir="rust/$tdir"
  local ext=""
  [[ "$os" == "windows" ]] && ext=".exe"
  cp "$tdir/$triple/release/dongminal$ext" "$out"
  echo "  ✓ $out"
}

# distPath 는 대상 하나의 출력 경로다. 확장자 규칙은
# platform.Paths.ExeSuffix 와 같다 — windows 만 .exe 다.
distPath() {
  local os="$1" arch="$2"
  # 선언을 나누는 이유: bash 의 local 은 빌트인이라 **모든 우변이 실행 전에
  # 한꺼번에 전개**된다. 한 줄에 쓰면 out 이 아직 비어 있는 os·arch 로 만들어져
  # dongminal--.exe 가 나온다.
  local out="$DIST/dongminal-$os-$arch"
  [[ "$os" == "windows" ]] && out="$out.exe"
  echo "$out"
}

# ── 인자 해석 ─────────────────────────────────────────
MODE="host"
OS=""
ARCH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      MODE="all"; shift ;;
    --os)
      [[ -n "${2:-}" ]] || die "--os 에 값이 없습니다"
      MODE="one"; OS="$2"; shift 2 ;;
    --arch)
      [[ -n "${2:-}" ]] || die "--arch 에 값이 없습니다"
      ARCH="$2"; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      die "알 수 없는 옵션: $1" ;;
  esac
done

case "$MODE" in
  host)
    read -r host triple <<<"$(host_target)"
    build_one "${host%%/*}" "${host##*/}" "$triple" "$BINARY"
    echo "빌드 완료: $BINARY"
    # FR-DFP-7: 방금 만든 것으로 재실행할 때 데몬을 갈아야 하는지 말한다.
    #
    # **방금 만든 바이너리에게 묻는다.** 판정 문구는 바이너리 한 자리에 있고
    # (FR-DFP-11), 여기서 bash 로 다시 적으면 두 벌이 되어 한쪽만 고쳐진다.
    # `--daemon` 은 HTTP 검사를 지나지 않으므로 서버가 떠 있지 않아도 즉시 답한다.
    #
    # 배포 대상(`--all`·`--os`)에서는 하지 않는다 — 그 산출물은 이 기계에서 도는
    # 데몬과 무관하고, 애초에 여기서 실행되지 않는다.
    bin="$BINARY"; [[ "$bin" == */* ]] || bin="./$bin"
    "$bin" health --daemon || true
    ;;

  one)
    ARCH="${ARCH:-amd64}"
    # 오타를 여기서 잡는다. cargo 는 모르는 대상에 낯선 오류를 낸다.
    printf '%s\n' "${TARGETS[@]}" | grep -qx "$OS/$ARCH" \
      || die "지원하지 않는 대상입니다: $OS/$ARCH"
    mkdir -p "$DIST"
    out="$(distPath "$OS" "$ARCH")"
    build_one "$OS" "$ARCH" "$(triple_for "$OS/$ARCH")" "$out"
    ;;

  all)
    rm -rf "$DIST"
    mkdir -p "$DIST"
    for t in "${TARGETS[@]}"; do
      os="${t%%/*}"; arch="${t##*/}"
      build_one "$os" "$arch" "$(triple_for "$t")" "$(distPath "$os" "$arch")"
    done
    echo "배포 빌드 완료: $DIST/"
    ;;
esac
