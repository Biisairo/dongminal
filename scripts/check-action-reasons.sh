#!/usr/bin/env bash
#
# 동작 사유 문구 대조 (SERVER_DRIVEN_ACTIONS_SRS FR-SDA-8 · TC-SDA-3).
#
# 서버가 낼 수 있는 사유 코드마다 ko·en 문구(`why.<코드>`)가 있는지 본다.
# 판정 논리는 internal/webserver/action 의 MissingPhrases 이고, 그 탐침은 Go 단위
# 시험(TestMissingPhrases)에 있다.
#
# 사용: scripts/check-action-reasons.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec go run ./scripts/check-action-reasons
