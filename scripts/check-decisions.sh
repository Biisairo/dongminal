#!/usr/bin/env bash
#
# 결정 색인 대조 (M5 `G8-1`).
#
# `docs/internal/decisions.md` 는 **생성물**이다. 원천은 SRS 안의 결정 항목이고,
# 어긋나면 여기서 멎는다.
#
# 왜: 결정은 그것을 낳은 요구 옆에 있어야 한다 — 그래서 SRS 안에 적어 왔다.
# 그 대가가 **찾는 길의 부재**였고, "우리가 왜 이렇게 했더라" 를 물으면 문서
# 백여 개를 뒤져야 했다. 색인이 그 길이지만, 손으로 적은 색인은 조용히 낡고
# 낡은 색인은 없는 것보다 나쁘다 — 있다고 믿게 만든다.
#
# 사용: scripts/check-decisions.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec go run ./scripts/gen-decisions -check
