#!/usr/bin/env bash
#
# 성능 측정 하네스 (M5 `G9-2` · PERFORMANCE_BUDGET.md §4).
#
# **CI 가 이것을 강제하지 않는다.** 러너의 부하가 값을 흔들어 게이트가 거짓
# 경보를 내고, 그러면 아무도 보지 않는 게이트가 된다 (§5 비목표 1).
# 사람이 의심할 때 돌린다.
#
# 사용:
#   scripts/perf-probe.sh                 격리 인스턴스를 띄워 재고 치운다
#   scripts/perf-probe.sh --port 58146    이미 도는 인스턴스에 대고 잰다
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT=""
N=30

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      cat <<'USAGE'
성능 측정 하네스

  격리 인스턴스를 띄워 종단별 응답 시간과 자원을 재고 치운다.

  --port <n>   이미 도는 인스턴스에 대고 잰다 (띄우지도 치우지도 않는다)
  --n <n>      종단마다 재는 횟수 (기본 30)

  예산은 docs/internal/PERFORMANCE_BUDGET.md 에 있다.
  **한 번의 숫자를 믿지 마라** — 넘으면 먼저 다시 재고, 두 번 넘으면 쫓는다.
USAGE
      exit 0 ;;
    --port) PORT="$2"; shift 2 ;;
    --n)    N="$2"; shift 2 ;;
    *) echo "알 수 없는 옵션: $1" >&2; exit 2 ;;
  esac
done

OWNED=0
HOME_DIR=""

cleanup() {
  if [[ $OWNED -eq 1 && -n "$PORT" ]]; then
    echo "── 치우는 중"
    env -u DONGMINAL_HOST -u DONGMINAL_PORT -u PORT \
      DONGMINAL_HOME="$HOME_DIR" ./dongminal stop --all --port "$PORT" >/dev/null 2>&1 || true
    [[ -n "$HOME_DIR" ]] && rm -rf "$HOME_DIR"
  fi
}
trap cleanup EXIT

if [[ -z "$PORT" ]]; then
  # **격리가 기본이다.** 운영 인스턴스에 대고 재면 그쪽 부하가 값에 섞이고,
  # 반대로 측정이 그쪽을 느리게 만든다.
  echo "── 격리 인스턴스를 띄운다"
  go build -o dongminal ./cmd/dongminal || exit 1
  HOME_DIR=$(mktemp -d)
  # **자기 전제를 스스로 세운다.** 이 스크립트는 dongminal 도구 안에서 돌 수 있고,
  # 그 셸에는 사용자의 실제 인스턴스를 가리키는 `DONGMINAL_*` 가 심겨 있다
  # (`toolhub.StartTool`). 물려받으면 격리 기동이 `DONGMINAL_HOST=0.0.0.0` 으로
  # 떠서 노출 게이트에 막히고, 측정은 시작조차 하지 못한다.
  out=$(env -u DONGMINAL_HOST -u DONGMINAL_PORT -u DONGMINAL_TOOL_ID \
            -u DONGMINAL_LOG -u DONGMINAL_LOG_LEVEL -u PORT \
            DONGMINAL_HOME="$HOME_DIR" ./dongminal start --isolated --home "$HOME_DIR" 2>&1) || {
    echo "$out"; exit 1; }
  PORT=$(printf '%s' "$out" | grep -oE 'http://[^:]+:[0-9]+' | head -1 | grep -oE '[0-9]+$')
  [[ -n "$PORT" ]] || { echo "포트를 읽지 못했습니다:"; echo "$out"; exit 1; }
  OWNED=1
  echo "   포트 $PORT · 홈 $HOME_DIR"
fi

BASE="http://127.0.0.1:$PORT"

# ms 단위 p95. `curl` 의 `time_total` 은 초 단위 실수다.
probe() {
  local label="$1" path="$2" budget="$3"
  local times=()
  for ((i = 0; i < N; i++)); do
    t=$(curl -s -o /dev/null -w '%{time_total}' "$BASE$path" 2>/dev/null) || t=0
    times+=("$t")
  done
  local p95
  p95=$(printf '%s\n' "${times[@]}" | sort -n | awk -v n="$N" '
    NR == int(n * 0.95) + 0 || NR == int(n * 0.95) { v = $1 } END { printf "%.1f", v * 1000 }')
  local mark="  "
  awk -v p="$p95" -v b="$budget" 'BEGIN { exit !(p > b) }' && mark="⚠ "
  printf '%s%-28s p95 %8s ms   (예산 %s ms)\n' "$mark" "$label" "$p95" "$budget"
}

echo
echo "── 종단별 응답 (n=$N)"
probe "GET /api/ping"        "/api/ping"        5
probe "GET /api/stats"       "/api/stats"       50
probe "GET /api/health"      "/api/health"      100
probe "GET /api/diag"        "/api/diag"        100
probe "GET /api/workspace"   "/api/workspace"   50

echo
echo "── 자원 (GET /api/diag)"
diag=$(curl -s "$BASE/api/diag")
if [[ -n "$diag" ]]; then
  echo "$diag" | tr ',' '\n' | grep -E '"(goroutines|allocMB|tools|ws|reconnects|uptime)"' \
    | sed 's/[{"]//g; s/^/   /'
  echo
  echo "   예산: goroutines 500 (도구 10개 기준) · allocMB 100 (유휴)"
else
  echo "   진단을 읽지 못했습니다"
fi

echo
echo "예산 전문: docs/internal/PERFORMANCE_BUDGET.md"
echo "⚠ 가 보이면 **먼저 다시 재세요** — 두 번 넘으면 그때 쫓습니다."
