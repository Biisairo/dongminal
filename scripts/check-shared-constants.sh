#!/usr/bin/env bash
#
# 공유 상수 대조 (SERVER_DRIVEN_ACTIONS_SRS FR-SDA-81 · K-j · TC-SDA-11).
#
# 서버가 보낼 수 없어 화면과 서버에 두 벌로 남은 상수(K9·K10·K12·K13·K17)와, 잡 표시기
# 종류의 라벨(K-h)을 본다. 판정 논리는 scripts/check-shared-constants 의 Check 이고,
# 그 탐침은 같은 자리의 Go 단위 시험에 있다. 계산(K6·K16)은 공유 표본 시험이 잰다.
#
# 사용: scripts/check-shared-constants.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec go run ./scripts/check-shared-constants
