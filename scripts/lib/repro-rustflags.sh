# shellcheck shell=bash
# 재현 가능 빌드의 RUSTFLAGS (GO_REMOVAL_SRS FR-GRM-5). 저장소 뿌리에서 source 하고, 부르기 전에
# ROOT(저장소 뿌리의 실제 경로)를 세운다. scripts/build.sh 와 e2e/global-setup.ts 가 같은 값을 써야
# 같은 cargo 산출물을 나눠 쓴다 — 플래그가 다르면 release 빌드가 두 벌 생긴다.
#
# Go 판 `-trimpath` 의 자리다 (04-secops SEC-30). 빌드한 사람의 파일 경로가
# 배포본에 박히면 러너가 다를 때 같은 소스에서 **다른 해시**가 나온다 — 그러면
# `SHA256SUMS` 가 "이 파일이 그 소스에서 나왔다" 를 말하지 못한다.
#
# · --remap-path-prefix : 저장소·CARGO_HOME·rustup sysroot 경로를 고정 이름으로 바꾼다.
# · --cfg dongminal_trimpath : env!("CARGO_MANIFEST_DIR") 처럼 remap 이 닿지 않는 경로를 지운다.
# · darwin -Wl,-S : ld64 의 LC_UUID 는 링크 결과의 해시인데, rustc 는 링크 **뒤에**
#   디버그 정보를 지운다. 그러면 UUID 에 오브젝트 파일의 절대 경로(OSO)가 섞인다.
#
# Go 판 `-buildvcs=false` 에 해당하는 것은 없다 — cargo 는 VCS 정보를 새기지 않는다.
repro_rustflags() {
  local triple="$1" flags="${RUSTFLAGS:-}"
  flags="${flags:+$flags }--cfg dongminal_trimpath"
  flags="$flags --remap-path-prefix=$ROOT=/dongminal"
  # windows(Git Bash): rustc 는 C:\… 형태의 경로를 본다.
  command -v cygpath >/dev/null && flags="$flags --remap-path-prefix=$(cygpath -w "$ROOT")=/dongminal"
  [[ -n "${CARGO_HOME:-}" ]] && flags="$flags --remap-path-prefix=$CARGO_HOME=/cargo"
  flags="$flags --remap-path-prefix=$HOME/.cargo=/cargo"
  flags="$flags --remap-path-prefix=$(cd "$ROOT/rust" && rustc --print sysroot)=/rustc"
  [[ "$triple" == *apple-darwin ]] && flags="$flags -C link-arg=-Wl,-S"
  echo "$flags"
}
