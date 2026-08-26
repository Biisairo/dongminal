#!/bin/bash
# dongminal 바이너리를 빌드한다. 이 저장소의 유일한 스크립트다 —
# 나머지 운영 동작(start/stop/migrate/health)은 바이너리의 액션이다.
#   ./scripts/build.sh && ./dongminal --help
set -e
cd "$(dirname "$0")/.."

BINARY="${BINARY:-dongminal}"
go build -o "$BINARY" ./cmd/dongminal
echo "빌드 완료: $BINARY"
