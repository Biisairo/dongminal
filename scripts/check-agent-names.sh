#!/usr/bin/env bash
#
# 에이전트 이름의 소유권 (AGENT_ADAPTER_COMPLETION_SRS FR-AAC-31·32).
#
# 지시는 이렇다 (2026-09-11):
#
#   "오늘 이후에는 agent adaptor 에 등록하는 부분을 제외하고는 특정 에이전트의
#    이름이 나오면 안된다."
#
# 이름이 등록부 밖에 있으면 **그 자리가 한 에이전트에만 맞는 코드**라는 뜻이고,
# 다음 에이전트를 붙일 때 아무도 그것을 찾지 못한다. 이 검사가 없던 동안 설치·
# 전사본·컨텍스트 창 셋이 그렇게 흩어져 있었다 (SRS §2.2~2.4).
#
# **재는 것은 실행 코드의 문자열 리터럴이다.** 주석은 지나간다 — 사실을 서술한
# 문장의 이름을 지우면 근거가 사라지기 때문이며(D-5), 도움말은 등록부에서
# 파생하므로(FR-AAC-30) 리터럴로 남지 않는다.
#
# 사용: scripts/check-agent-names.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
에이전트 이름 소유권 검사

  `internal/shared/agentadapter/` 밖의 **실행 코드**에 에이전트 id 문자열
  리터럴이 없어야 한다 (FR-AAC-31).

  지나가는 것:
    · 주석 (`//` 로 시작하는 줄)
    · 테스트 (`_test.go`) — 특정 에이전트의 동작을 재는 것은 정당하다
    · 등록부 자신 (`internal/shared/agentadapter/`)

  id 의 진실은 등록부다 — 이 스크립트는 목록을 따로 적지 않고 거기서 읽는다.
USAGE
  exit 0
fi

ADAPTER_DIR=internal/shared/agentadapter
fail=0

# 등록된 id 를 **선언에서** 얻는다. 여기 다시 적으면 목록이 두 벌이 된다.
ids=$(grep -hoE '(ID:[[:space:]]*"[a-z0-9_-]+"|^const [a-zA-Z]*ID = "[a-z0-9_-]+")' \
        "$ADAPTER_DIR"/*.go 2>/dev/null |
      grep -oE '"[a-z0-9_-]+"' | tr -d '"' | sort -u)

if [[ -z "$ids" ]]; then
  echo "!! 등록된 에이전트 id 를 읽지 못했다 ($ADAPTER_DIR) — 검사가 성립하지 않는다"
  exit 1
fi

for id in $ids; do
  # 실행 코드의 리터럴만 본다: 주석 줄과 테스트, 등록부는 제외한다.
  hits=$(grep -rn "\"$id\"" --include='*.go' internal cmd 2>/dev/null |
         grep -v "^$ADAPTER_DIR/" |
         grep -v '_test\.go:' |
         grep -vE '^[^:]+:[0-9]+:[[:space:]]*//' |
         grep -vE '^[^:]+:[0-9]+:[[:space:]]*\*')
  if [[ -n "$hits" ]]; then
    echo "── 에이전트 이름 \"$id\" 가 등록부 밖의 실행 코드에 있다 (FR-AAC-31)"
    echo "$hits"
    echo "   → 그 자리가 한 에이전트에만 맞는 코드라는 신호다. Adapter 에 선언을"
    echo "     두고 그것으로 가려라 (예: ActivityFromNotify · InstallAssets)."
    fail=1
  fi
done

if [[ $fail -ne 0 ]]; then
  exit 1
fi
echo "에이전트 이름 ok — 등록부 밖에 리터럴이 없다"
