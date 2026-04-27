#!/bin/bash
# LAN 노출 실행 (0.0.0.0 바인딩, 사내망의 다른 기기에서도 접근 가능)
exec "$(dirname "$0")/start.sh" --expose "$@"
