#!/usr/bin/env bash
#
# 데몬 코드의 지문 (DAEMON_STALENESS_SRS FR-DFP-2).
#
# `dongminald` 프로세스가 실행하는 저장소 코드의 내용 해시다. `scripts/build.sh`
# 가 이 값을 바이너리에 새기고(`cli.DaemonBuild`), 데몬이 기동하며 홈에 남기고,
# `dongminal health --daemon` 이 둘을 견준다.
#
# **왜 별도 스크립트인가**: 계산의 정의역이 한 자리에 있어야 검사할 수 있다.
# `scripts/test/daemon-fingerprint.test.mjs` 가 여기를 부른다 — 정의역이 웹서버로
# 새면 거의 모든 빌드가 불일치로 읽히고, 그러면 이 기능은 "늘 --restart-daemon"
# 과 같아져 없느니만 못하다.
#
# 사용: scripts/daemon-fingerprint.sh [--os <os>] [--arch <arch>] [--files]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# 데몬 프로세스의 진입점. 여기서 닿는 저장소 패키지가 곧 데몬이 실행하는 것의
# 전부다 — `cmd/dongminal` 은 넣지 않는다 (D-2: main 은 웹서버 코드 전부를
# 의존하므로 넣으면 거의 모든 빌드가 불일치가 된다).
ROOT_PKG=dongminal/internal/daemon/boot

OS=""
ARCH=""
MODE="hash"

usage() {
  cat <<'USAGE'
데몬 코드의 지문

사용법:
  scripts/daemon-fingerprint.sh                    호스트 대상의 지문 12자
  scripts/daemon-fingerprint.sh --os windows       그 대상의 지문
  scripts/daemon-fingerprint.sh --files            지문이 세는 파일 목록

옵션:
  --os <os>      GOOS (기본: 호스트)
  --arch <arch>  GOARCH (기본: 호스트)
  --files        해시 대신 정의역의 파일 목록을 낸다 (저장소 상대 경로, 정렬됨)
  -h, --help     이 도움말

정의역:
  · 패키지 — `go list -deps dongminal/internal/daemon/boot` 중 dongminal/ 접두
  · 파일   — 그 패키지들의 GoFiles + EmbedFiles
  · 대상   — GOOS/GOARCH 마다 따로 센다 (platform 이 OS 마다 다른 파일을 갖는다)

  EmbedFiles 를 세는 이유: shared/runtime 이 헬퍼와 에이전트 플러그인을
  go:embed 로 담는다. 그 자산만 바뀐 빌드도 데몬이 설치하는 것을 바꾼다.

  경로·시각·빌드 환경은 들어가지 않는다 — 같은 소스는 어느 기계에서도 같은
  지문이어야 재현 가능 빌드가 유지된다 (build.sh 의 REPRO_FLAGS 와 같은 근거).
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --os)   OS="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    --files) MODE="files"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 1 ;;
  esac
done

export GOOS="${OS:-$(go env GOHOSTOS)}"
export GOARCH="${ARCH:-$(go env GOHOSTARCH)}"

# 파일 목록. `go list` 가 절대 경로를 내므로 저장소 루트를 기준으로 되돌린다 —
# 빌드한 사람의 홈 경로가 지문에 섞이면 같은 소스가 기계마다 다른 값을 낸다.
files() {
  go list -deps "$ROOT_PKG" 2>/dev/null \
    | grep '^dongminal/' \
    | xargs go list -f '{{$d := .Dir}}{{range .GoFiles}}{{$d}}/{{.}}
{{end}}{{range .EmbedFiles}}{{$d}}/{{.}}
{{end}}' 2>/dev/null \
    | sed "s|^$PWD/||" \
    | LC_ALL=C sort
}

if [[ "$MODE" == "files" ]]; then
  files
  exit 0
fi

list=$(files)
if [[ -z "$list" ]]; then
  # 빈 지문은 **모른다**다 (FR-DFP-3). 여기서 거짓 값을 내면 그 뒤의 판정이
  # 모두 거짓이 되므로, 계산하지 못했으면 아무것도 말하지 않는다.
  exit 1
fi

# `shasum -a 256` 은 macOS·Linux 양쪽에 있다. 없으면 `sha256sum` 으로 간다.
if command -v shasum >/dev/null 2>&1; then
  sum() { shasum -a 256 "$@"; }
else
  sum() { sha256sum "$@"; }
fi

printf '%s\n' "$list" | xargs sum 2>/dev/null | sum | cut -c1-12
