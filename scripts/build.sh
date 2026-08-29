#!/usr/bin/env bash
#
# dongminal 빌드. 이 저장소의 유일한 빌드 스크립트다 — 나머지 운영 동작
# (start/stop/migrate/health)은 바이너리의 액션이다. 사용법은 `-h` 참조.
set -e
cd "$(dirname "$0")/.."

BINARY="${BINARY:-dongminal}"
DIST="${DIST:-dist}"

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

참고:
  · Go 는 교차 컴파일이 기본이라 별도 툴체인이 필요 없다.
  · 프론트엔드는 go:embed 로 들어간다. npm 은 e2e(Playwright) 전용이다.
  · darwin 대상은 cgo 가 필요하다 (sysstat 의 mach 호출 — CPU·메모리 지표).
    go 는 교차 빌드에서 cgo 를 자동으로 끄므로 이 스크립트가 다시 켠다.
    손으로 \`GOOS=darwin GOARCH=amd64 go build\` 하면 그 두 지표를 잃는다.

관련:
  scripts/check-cross.sh   대상 전량 build + vet
  scripts/check-seams.sh   OS 의존 호출이 platform 밖에 없는지
EOF
}

die() { echo "$*" >&2; echo >&2; usage >&2; exit 1; }

# ── CGO 정책 ──────────────────────────────────────────
#
# 이 저장소의 cgo 는 딱 하나다 — sysstat 의 mach 호출(CPU tick·VM 통계).
# macOS 에서 그 두 지표는 mach 인터페이스로만 얻을 수 있다.
#
#   · linux·windows : cgo 불필요. 지표를 /proc 과 WinAPI 로 읽는다.
#                     CGO_ENABLED=0 으로 못박아 정적 바이너리를 낸다.
#   · darwin        : cgo 가 **필요하다**. 끄면 CPU% 와 메모리 사용량이
#                     빠진 채로 빌드된다 (mach_darwin_nocgo.go).
#
# 함정: go 는 GOOS/GOARCH 가 호스트와 다르면 CGO_ENABLED 를 자동으로 0 으로
# 내린다. arm64 맥에서 darwin/amd64 를 빌드하면 그것만 지표를 잃는다는 뜻이다.
# Xcode clang 은 두 아키텍처를 모두 컴파일하므로 여기서 다시 켜 준다.
cgo_for() {
  case "$1" in
    darwin) [[ "$(go env GOHOSTOS)" == "darwin" ]] && echo 1 || echo 0 ;;
    *)      echo 0 ;;
  esac
}

build_one() {
  local os="$1" arch="$2" out="$3"
  local cgo; cgo="$(cgo_for "$os")"
  CGO_ENABLED="$cgo" GOOS="$os" GOARCH="$arch" go build -o "$out" ./cmd/dongminal
  if [[ "$os" == "darwin" && "$cgo" == "0" ]]; then
    # 건너뛰지 않고 빌드하되 사실을 남긴다. 경고가 없으면 지표가 빠진 배포본이
    # 조용히 나간다.
    echo "  ⚠ $out — darwin 이 아닌 호스트라 cgo 없이 빌드했습니다."
    echo "     CPU 사용률과 메모리 사용량이 상태바에서 빠집니다 (나머지는 정상)."
  else
    echo "  ✓ $out"
  fi
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
    build_one "$(go env GOHOSTOS)" "$(go env GOHOSTARCH)" "$BINARY"
    echo "빌드 완료: $BINARY"
    ;;

  one)
    ARCH="${ARCH:-amd64}"
    # 오타를 여기서 잡는다. go build 는 모르는 GOOS 에 낯선 오류를 낸다.
    printf '%s\n' "${TARGETS[@]}" | grep -qx "$OS/$ARCH" \
      || die "지원하지 않는 대상입니다: $OS/$ARCH"
    mkdir -p "$DIST"
    out="$(distPath "$OS" "$ARCH")"
    build_one "$OS" "$ARCH" "$out"
    ;;

  all)
    rm -rf "$DIST"
    mkdir -p "$DIST"
    for t in "${TARGETS[@]}"; do
      os="${t%%/*}"; arch="${t##*/}"
      build_one "$os" "$arch" "$(distPath "$os" "$arch")"
    done
    echo "배포 빌드 완료: $DIST/"
    ;;
esac
