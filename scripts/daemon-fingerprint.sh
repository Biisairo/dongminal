#!/usr/bin/env bash
#
# 데몬 코드의 지문 (DAEMON_STALENESS_SRS FR-DFP-2).
#
# `dongminald` 프로세스가 실행하는 저장소 코드의 내용 해시다. `scripts/build.sh`
# 가 이 값을 바이너리에 새기고(`DONGMINAL_BUILD_DAEMON`), 데몬이 기동하며 홈에
# 남기고, `dongminal health --daemon` 이 둘을 견준다.
#
# **왜 별도 스크립트인가**: 계산의 정의역이 한 자리에 있어야 검사할 수 있다.
# `scripts/test/daemon-fingerprint.test.mjs` 가 여기를 부른다 — 정의역이 웹서버로
# 새면 거의 모든 빌드가 불일치로 읽히고, 그러면 이 기능은 "늘 --restart-daemon"
# 과 같아져 없느니만 못하다.
#
# 사용: scripts/daemon-fingerprint.sh [--os <os>] [--arch <arch>] [--files]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../rust" || exit 1

# 데몬 프로세스의 진입점. 여기서 닿는 워크스페이스 crate 가 곧 데몬이 실행하는 것의
# 전부다 — `dongminal`(cmd) 은 넣지 않는다 (D-2: main 은 웹서버 코드 전부를
# 의존하므로 넣으면 거의 모든 빌드가 불일치가 된다).
ROOT_PKG=dm-daemon-boot

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
  --os <os>      darwin | linux | windows (기본: 호스트)
  --arch <arch>  amd64 | arm64 (기본: 호스트)
  --files        해시 대신 정의역의 파일 목록을 낸다 (rust/ 상대 경로, 정렬됨)
  -h, --help     이 도움말

정의역:
  · crate — `cargo metadata --filter-platform <대상>` 의 의존 그래프에서
            dm-daemon-boot 가 normal·build 의존으로 닿는 워크스페이스 crate
  · 파일   — 그 crate 디렉터리 아래의 파일 전부(src·assets·build.rs·Cargo.toml)
  · 대상   — 대상마다 따로 센다 (platform 이 OS 마다 다른 코드를 갖는다).
            crate 디렉터리는 모든 OS 의 파일을 담으므로 대상 이름도 해시에 넣는다

  assets 를 세는 이유: shared/runtime 이 헬퍼와 에이전트 플러그인을 바이너리에
  담는다. 그 자산만 바뀐 빌드도 데몬이 설치하는 것을 바꾼다.

  경로·시각·빌드 환경은 들어가지 않는다 — 같은 소스는 어느 기계에서도 같은
  지문이어야 재현 가능 빌드가 유지된다 (build.sh 의 재현 가능 빌드와 같은 근거).
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --os|--arch)
      if [[ -z "${2:-}" ]]; then echo "$1 에 값이 없습니다" >&2; usage >&2; exit 1; fi
      if [[ "$1" == "--os" ]]; then OS="$2"; else ARCH="$2"; fi
      shift 2 ;;
    --files) MODE="files"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 1 ;;
  esac
done

host="$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')"
case "$host" in
  *-apple-darwin) host_os=darwin ;;
  *-linux-*)      host_os=linux ;;
  *-windows-*)    host_os=windows ;;
  *)              host_os="" ;;
esac
case "$host" in
  x86_64-*)  host_arch=amd64 ;;
  aarch64-*) host_arch=arm64 ;;
  *)         host_arch="" ;;
esac
OS="${OS:-$host_os}"
ARCH="${ARCH:-$host_arch}"

# 대상 이름은 Go 이름이다. linux 는 scripts/build.sh 와 같이 musl 이다.
case "$ARCH" in
  amd64) cpu=x86_64 ;;
  arm64) cpu=aarch64 ;;
  *) exit 1 ;;
esac
case "$OS" in
  darwin)  TARGET="$cpu-apple-darwin" ;;
  linux)   TARGET="$cpu-unknown-linux-musl" ;;
  windows) TARGET="$cpu-pc-windows-msvc" ;;
  *) exit 1 ;;
esac

# 파일 목록. 절대 경로는 rust/ 기준으로 되돌린다 — 빌드한 사람의 홈 경로가 지문에
# 섞이면 같은 소스가 기계마다 다른 값을 낸다.
# windows 러너의 Git Bash 에는 python3 가 없거나 스토어 안내 껍데기일 수 있다.
PY=""
for p in python3 python; do
  if "$p" -c '' >/dev/null 2>&1; then PY="$p"; break; fi
done
[[ -n "$PY" ]] || exit 1

files() {
  cargo metadata --format-version 1 --filter-platform "$TARGET" 2>/dev/null \
    | "$PY" -I -c '
import json, os, sys
root_pkg, base = sys.argv[1], os.path.realpath(sys.argv[2])
m = json.load(sys.stdin)
members = set(m["workspace_members"])
pkgs = {p["id"]: p for p in m["packages"]}
nodes = {n["id"]: n for n in m["resolve"]["nodes"]}
start = [i for i in members if pkgs[i]["name"] == root_pkg]
seen, todo = set(), list(start)
while todo:
    i = todo.pop()
    if i in seen or i not in members:
        continue
    seen.add(i)
    for d in nodes[i]["deps"]:
        if any(k["kind"] in (None, "build") for k in d["dep_kinds"]):
            todo.append(d["pkg"])
out = []
for i in seen:
    d = os.path.dirname(os.path.realpath(pkgs[i]["manifest_path"]))
    for r, ds, fs in os.walk(d):
        ds[:] = [x for x in ds if x != "target"]
        for f in fs:
            # 경로 구분자를 / 로 맞춘다 — windows 에서 계산해도 같은 지문이어야 한다.
            out.append(os.path.relpath(os.path.join(r, f), base).replace(os.sep, "/"))
print("\n".join(sorted(out)))
' "$ROOT_PKG" "$PWD" 2>/dev/null
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

# 함수가 아니라 배열로 둔다 — xargs 는 셸 함수를 부르지 못한다 (DIFF-29: Go 판은
# 그래서 /usr/bin/sum 이 돌았다). `shasum -a 256` 이 없으면 `sha256sum` 으로 간다.
if command -v shasum >/dev/null 2>&1; then
  SUM=(shasum -a 256)
else
  SUM=(sha256sum)
fi

{
  echo "$OS/$ARCH"
  printf '%s\n' "$list" | LC_ALL=C sort | tr '\n' '\0' | xargs -0 "${SUM[@]}"
} | "${SUM[@]}" | cut -c1-12
