#!/bin/bash
# dongminal 바이너리를 빌드한다. 이 저장소의 유일한 스크립트다 —
# 나머지 운영 동작(start/stop/migrate/health)은 바이너리의 액션이다.
#
# npm 단계가 없는 것은 누락이 아니다. 프론트엔드는 번들러가 없어 index.html 이
# web/js/**/*.js 원본을 그대로 로드하고 web/vendor/xterm.js 는 저장소에 있으므로,
# go:embed 가 전부 담는다. npm 은 e2e(Playwright) 전용이다 — README 의 테스트 절.
#   ./scripts/build.sh && ./dongminal --help
set -e
cd "$(dirname "$0")/.."

BINARY="${BINARY:-dongminal}"
go build -o "$BINARY" ./cmd/dongminal
echo "빌드 완료: $BINARY"
