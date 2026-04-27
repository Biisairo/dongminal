#!/bin/bash
# Local-only 실행 (127.0.0.1 바인딩, 동일 PC 에서만 접근 가능)
exec "$(dirname "$0")/start.sh" --local "$@"
