#!/usr/bin/env bash
#
# 크로스 컴파일 게이트 (CROSS_PLATFORM_SRS FR-XBD-2).
#
# 대상 전량에 대해 build 와 vet 을 돌린다. vet 이 테스트 파일까지 타입 검사하므로,
# 어느 플랫폼에서만 깨지는 테스트도 여기서 잡힌다.
#
# 사용: scripts/check-cross.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
크로스 컴파일 게이트

  scripts/check-cross.sh

대상 전량에 build 와 vet 을 돌린다. vet 이 테스트 파일까지 타입 검사하므로,
어느 플랫폼에서만 깨지는 테스트도 여기서 잡힌다. 하나라도 실패하면 비영 종료.

바이너리를 만들지는 않는다 — 그것은 scripts/build.sh 다.
EOF
  exit 0
fi

TARGETS=(
  "darwin/arm64"
  "darwin/amd64"
  "linux/amd64"
  "linux/arm64"
  "windows/amd64"
)

fail=0
for t in "${TARGETS[@]}"; do
  os="${t%%/*}"
  arch="${t##*/}"
  printf '%-16s ' "$t"
  if ! out=$(GOOS="$os" GOARCH="$arch" go build ./... 2>&1); then
    echo "❌ build"
    echo "$out" | sed 's/^/     /'
    fail=1
    continue
  fi
  if ! out=$(GOOS="$os" GOARCH="$arch" go vet ./... 2>&1); then
    echo "❌ vet"
    echo "$out" | sed 's/^/     /'
    fail=1
    continue
  fi
  echo "✅"
done

exit $fail
