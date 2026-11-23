#!/usr/bin/env bash
#
# 크로스 컴파일 게이트 (CROSS_PLATFORM_SRS FR-XBD-2, GO_REMOVAL_SRS G-17).
#
# 대상 전량에 대해 build(`cargo check`) 와 vet(`cargo clippy -D warnings`) 을 돌린다.
# 둘 다 `--all-targets` 라 테스트 코드까지 타입 검사하므로, 어느 플랫폼에서만 깨지는
# 테스트도 여기서 잡힌다. 대상별 C 툴체인 없이 도는 방법은 rust/scripts/cross-check.sh 다.
#
# 사용: scripts/check-cross.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
크로스 컴파일 게이트

  scripts/check-cross.sh

대상 전량에 build(cargo check) 와 vet(cargo clippy -D warnings) 을 돌린다.
둘 다 --all-targets 라 테스트 코드까지 타입 검사하므로, 어느 플랫폼에서만 깨지는
테스트도 여기서 잡힌다. 하나라도 실패하면 비영 종료.

바이너리를 만들지는 않는다 — 그것은 scripts/build.sh 다.
EOF
  exit 0
fi

# 이름은 Go 판 대상 이름 그대로 보인다. Linux 는 배포 산출물과 같은 musl 정적
# 대상이다 (GO_REMOVAL_SRS FR-GRM-2, Q-GRM-1).
TARGETS=(
  "darwin/arm64|aarch64-apple-darwin"
  "darwin/amd64|x86_64-apple-darwin"
  "linux/amd64|x86_64-unknown-linux-musl"
  "linux/arm64|aarch64-unknown-linux-musl"
  "windows/amd64|x86_64-pc-windows-msvc"
)

if [[ ! -f rust/Cargo.toml ]]; then
  echo "rust/Cargo.toml 이 없습니다 — 검사할 워크스페이스가 없어 빈 통과를 막습니다."
  exit 1
fi

fail=0
for entry in "${TARGETS[@]}"; do
  t="${entry%%|*}"
  triple="${entry#*|}"
  printf '%-16s ' "$t"
  if ! out=$(CROSS_CARGO=check rust/scripts/cross-check.sh "$triple" 2>&1); then
    echo "❌ build"
    echo "$out" | sed 's/^/     /'
    fail=1
    continue
  fi
  if ! out=$(rust/scripts/cross-check.sh "$triple" 2>&1); then
    echo "❌ vet"
    echo "$out" | sed 's/^/     /'
    fail=1
    continue
  fi
  echo "✅"
done

exit $fail
