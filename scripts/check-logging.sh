#!/usr/bin/env bash
#
# 로그의 단일 경로 (OBSERVABILITY_SRS FR-OBS-5·20 · M5 `GO-43`/`SEC-24`).
#
# 제품 코드는 표준 `log` 를 직접 부르지 않는다. `internal/shared/dmlog` 를 지난다.
#
# 왜 게이트가 필요한가: 착수 시 `log.Printf` 가 **172곳**이었다(로드맵은 146곳으로
# 적고 있었다 — 그사이 늘었다). 한 번 걷어 내는 것은 쉽고, **다시 늘지 않게 하는
# 것**이 본체다. `scripts/check-timers.sh` 와 같은 형태다.
#
# 옮겨서 얻는 것 셋: 수준(치명과 잡음을 가른다) · 시각 형식의 단일화 ·
# **요청 ID**(한 요청이 남긴 줄이 서로를 가리킨다).
#
# 사용: scripts/check-logging.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
로그의 단일 경로 검사

  제품 코드(internal/ · cmd/ 의 비검사 Go 소스)에 아래가 없어야 한다:

    log.Printf  log.Println  log.Print  log.Fatal*  log.Panic*

  대신 dmlog 를 쓴다:

    dmlog.Infof(ctx, "…")      옛 log.Printf 가 옮겨 앉는 자리
    dmlog.Warn(ctx, "msg", "k", v)   새로 쓰는 자리 (키-값)

  지나가는 것:
    *_test.go            검사의 출력은 제품의 로그가 아니다
    internal/shared/dmlog  계층 자신. 표준 log 의 출력을 여기로 돌린다
USAGE
  exit 0
fi

hits=$(
  grep -rnE '\blog\.(Printf|Println|Print|Fatal|Fatalf|Fatalln|Panic|Panicf|Panicln)\(' \
    --include='*.go' --exclude='*_test.go' internal cmd 2>/dev/null \
    | grep -v '^internal/shared/dmlog/'
)

if [[ -n "$hits" ]]; then
  echo "표준 log 를 직접 부르는 자리가 있습니다 (FR-OBS-5):"
  echo "$hits"
  echo
  echo "dmlog 로 옮기세요 — 수준·시각·요청 ID 가 거기서 붙습니다."
  echo "  log.Printf(\"x %v\", e)  →  dmlog.Errorf(ctx, \"x %v\", e)"
  exit 1
fi

echo "logging ok — 제품 코드에 표준 log 직접 호출 0곳"
