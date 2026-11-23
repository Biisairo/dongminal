#!/usr/bin/env bash
#
# 데몬 코드의 지문 (DAEMON_STALENESS_SRS FR-DFP-2) — Rust 판.
#
# `dongminald` 가 실행하는 저장소 코드의 내용 해시다. `rust/scripts/build.sh` 가 이 값을
# `DONGMINAL_BUILD_DAEMON` 으로 바이너리에 새기고(`dm_ctl_cli::DAEMON_BUILD`), 데몬이 기동하며
# 홈에 남기고, `dongminal health --daemon` 이 둘을 견준다.
#
# 사용: rust/scripts/daemon-fingerprint.sh [--target <triple>] [--files]
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

# 데몬 프로세스의 진입점. 여기서 닿는 워크스페이스 crate 가 데몬이 실행하는 것의 전부다 —
# `dongminal`(cmd) 은 넣지 않는다 (D-2: main 은 웹서버 코드 전부를 의존한다).
ROOT_PKG=dm-daemon-boot

TARGET=""
MODE="hash"

usage() {
  cat <<'USAGE'
데몬 코드의 지문 (Rust)

사용법:
  rust/scripts/daemon-fingerprint.sh                       호스트 대상의 지문 12자
  rust/scripts/daemon-fingerprint.sh --target <triple>     그 대상의 지문
  rust/scripts/daemon-fingerprint.sh --files               지문이 세는 파일 목록

옵션:
  --target <triple>  rustc 대상 (기본: 호스트)
  --files            해시 대신 정의역의 파일 목록을 낸다 (rust/ 상대 경로, 정렬됨)
  -h, --help         이 도움말

정의역:
  · crate — `cargo metadata --filter-platform <대상>` 의 의존 그래프에서 dm-daemon-boot 가
            normal·build 의존으로 닿는 워크스페이스 crate
  · 파일   — 그 crate 디렉터리 아래의 파일 전부(src·assets·build.rs·Cargo.toml 포함)
  · 대상   — 대상마다 따로 센다 (platform 이 OS 마다 다른 의존을 갖는다)

  Go 판(GoFiles+EmbedFiles)보다 넓다 — crate 안의 시험 파일도 센다. 넓으면 "갈아야 한다" 쪽으로
  틀릴 뿐이고, 좁으면 낡은 데몬을 놓친다.

  경로·시각·빌드 환경은 들어가지 않는다 — 같은 소스는 어느 기계에서도 같은 지문이다.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --files) MODE="files"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  TARGET="$(rustc -vV 2>/dev/null | sed -n 's/^host: //p')"
fi
[[ -n "$TARGET" ]] || exit 1

# 파일 목록. 절대 경로는 rust/ 기준으로 되돌린다 — 빌드한 사람의 홈 경로가 지문에 섞이면
# 같은 소스가 기계마다 다른 값을 낸다.
files() {
  cargo metadata --format-version 1 --filter-platform "$TARGET" 2>/dev/null \
    | python3 -I -c '
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
            out.append(os.path.relpath(os.path.join(r, f), base))
print("\n".join(sorted(out)))
' "$ROOT_PKG" "$PWD"
}

if [[ "$MODE" == "files" ]]; then
  files
  exit 0
fi

list=$(files)
if [[ -z "$list" ]]; then
  # 빈 지문은 **모른다**다 (FR-DFP-3). 계산하지 못했으면 아무것도 말하지 않는다.
  exit 1
fi

# 함수가 아니라 배열로 둔다 — xargs 는 셸 함수를 부르지 못한다(Go 판은 그래서 /usr/bin/sum 이 돈다).
if command -v shasum >/dev/null 2>&1; then
  SUM=(shasum -a 256)
else
  SUM=(sha256sum)
fi

printf '%s\n' "$list" | LC_ALL=C sort | tr '\n' '\0' | xargs -0 "${SUM[@]}" | "${SUM[@]}" | cut -c1-12
