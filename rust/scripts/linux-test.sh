#!/usr/bin/env bash
#
# linux 실기 시험 (RUST_PORT_SRS NFR-RSP-5). 컨테이너 안에서 격리 `cargo test --workspace` 를 돈다.
# 컨테이너는 따로 된 네트워크·PID·HOME 이라 운영 인스턴스에 닿지 않는다.
#
#   · 저장소는 읽기 전용으로 마운트하고, 빌드 산출물·레지스트리는 컨테이너 볼륨에 둔다
#   · --init: 죽은 자식을 거두는 init 이 없으면 "그룹을 죽였는가" 시험이 좀비를 산 것으로 본다
#   · ripgrep: 탐색기 검색 골든은 rg 가 있는 환경에서 뽑았다(engine=ripgrep)
#   · TZ=Asia/Seoul: zip 골든의 DOS 시각은 지역 시각이고 Go 정답을 KST 에서 뽑았다
#   · 작은 VM(2GiB)에서 rustc 가 OOM 으로 죽지 않게 병렬 1·디버그 정보 없음
#
# 사용: rust/scripts/linux-test.sh [--platform linux/amd64] [cargo test 인자...]
#   ENGINE(기본 podman, 없으면 docker), IMAGE(기본 rust:<rust-version>-bookworm)
set -euo pipefail
cd "$(dirname "$0")/../.."

ENGINE="${ENGINE:-$(command -v podman >/dev/null && echo podman || echo docker)}"
ver="$(sed -n 's/^rust-version = "\(.*\)"/\1/p' rust/Cargo.toml | head -1)"
IMAGE="${IMAGE:-docker.io/library/rust:$ver-bookworm}"
PLATFORM=()
if [[ "${1:-}" == "--platform" ]]; then
  PLATFORM=(--platform "$2"); shift 2
fi
tag="$(echo "${PLATFORM[1]:-native}" | tr '/' '-')"

# 안쪽 스크립트는 컨테이너에서 전개한다.
# shellcheck disable=SC2016
exec "$ENGINE" run --rm --init ${PLATFORM[@]+"${PLATFORM[@]}"} \
  -v "$PWD":/src:ro \
  -v "dm-rust-target-$tag":/target \
  -v "dm-rust-cargo-$tag":/usr/local/cargo/registry \
  -e CARGO_TARGET_DIR=/target -e CARGO_INCREMENTAL=0 -e CARGO_BUILD_JOBS=1 \
  -e CARGO_PROFILE_DEV_DEBUG=0 -e CARGO_PROFILE_TEST_DEBUG=0 -e TZ=Asia/Seoul \
  -w /src/rust "$IMAGE" bash -c '
    set -e
    apt-get update -qq >/dev/null && apt-get install -y -qq ripgrep >/dev/null
    # worktree 의 .git 은 마운트하지 않은 본 저장소를 가리키므로 저장소 밖에서 부른다.
    git -C / config --global --add safe.directory "*"
    echo "linux-test: $(uname -m) $(rustc --version) $(git --version) $(rg --version | head -1)"
    scripts/hermetic.sh cargo test --workspace --locked --no-fail-fast "$@"
  ' linux-test "$@"
