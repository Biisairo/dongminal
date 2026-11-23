#!/usr/bin/env bash
#
# 로그의 단일 경로 (OBSERVABILITY_SRS FR-OBS-5·20 · M5 `GO-43`/`SEC-24`, GO_REMOVAL_SRS G-18).
#
# 제품 코드는 `log`·`tracing` 매크로나 `eprintln!` 를 직접 부르지 않는다.
# `rust/crates/shared/dmlog` 를 지난다. CLI 의 사용자 출력(`println!`·`writeln!(stdout`·
# `writeln!(stderr`)은 로그가 아니라 대상이 아니다.
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

  제품 코드(rust/crates/ 의 비검사 Rust 소스, scripts/ 제외)에 아래가 없어야 한다:

    log::{trace,debug,info,warn,error}!  tracing::{…}!  eprintln!  eprint!

  대신 dmlog 를 쓴다:

    dmlog::infof!(ctx, "…")          옛 log.Printf 가 옮겨 앉는 자리
    dmlog::warn(ctx, "msg", &[("k", v)])   새로 쓰는 자리 (키-값)

  지나가는 것:
    시험 전용 파일 (tests/·tests.rs·#[cfg(test)] mod)   검사의 출력은 제품의 로그가 아니다
    rust/crates/shared/dmlog         계층 자신
    rust/crates/scripts              게이트·생성기 프로그램 (Go 판에서도 대상 밖)
USAGE
  exit 0
fi

n_files=$(find rust/crates -name '*.rs' -not -path '*/target/*' | wc -l | tr -d ' ')
if [[ "$n_files" -eq 0 ]]; then
  echo "검사할 Rust 소스가 없습니다 (rust/crates/**/*.rs) — 빈 통과를 막습니다."
  exit 1
fi

source scripts/lib/rs-src.sh
hits=$(
  grep -rnE '\b((log|tracing)::(trace|debug|info|warn|error|event|span)|eprintln|eprint)!' \
    --include='*.rs' rust/crates 2>/dev/null \
    | grep -vE '^rust/crates/(shared/dmlog|scripts)/' \
    | rs_drop_tests \
    | grep -vE '^\S+:[0-9]+:\s*//'
)

if [[ -n "$hits" ]]; then
  echo "표준 log 를 직접 부르는 자리가 있습니다 (FR-OBS-5):"
  echo "$hits"
  echo
  echo "dmlog 로 옮기세요 — 수준·시각·요청 ID 가 거기서 붙습니다."
  echo "  eprintln!(\"x {e}\")  →  dmlog::errorf!(ctx, \"x {e}\")"
  exit 1
fi

echo "logging ok — 제품 코드에 표준 log 직접 호출 0곳"
