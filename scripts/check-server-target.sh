#!/usr/bin/env bash
#
# 겨누는 자리가 **한 규칙을 지나는가** (STRUCTURE_CLEANUP_SRS FR-STR-27, GO_REMOVAL_SRS G-23).
#
# 같은 물음("어느 서버를 겨누는가")에 답이 다섯 벌 있었고 그중 셋만 선언된 계약을
# 지켰다. `CONFIG_MANAGEMENT_SRS` FR-CFG-13 이 플래그 > 환경변수 > 파일 > 기본값을
# 계약으로 적었는데, `health`·`window`·`stop`·`migrate` 는 `Common.ResolvePort` 의
# 3계층에 머물러 **`server.json` 을 못 본다.**
#
# 대가가 가장 큰 자리는 `stop` 이다 — `killPort` 는 대상을 가리지 않으므로,
# `server.json` 에 포트를 적어 둔 사용자에게 그 명령은 **남의 프로세스에
# TERM→KILL 을 보낸다.**
#
# Go 기준선 `window.go` 의 주석은 이미 이렇게 적고 있었다:
#
#   FR-WIN-2: 대상 주소를 `start` 와 같은 규칙으로 정한다. 두 곳이 다르면
#   띄운 자리와 여는 자리가 어긋난다.
#
# **주석은 다음 사람을 막지 못한다.**
#
# ## 두 자리를 본다
#
#   ① 주소 조립 — `format!("{host}:{port}")`·`format!("http://{}:{}", …)` 꼴이 없다.
#      `otterenv::listen_addr`·`base_url`(Go `net.JoinHostPort`)을 지나야 IPv6 가 산다
#      (`::1` 은 대괄호가 필요하다). Go 판 때 저장소 전체에 `JoinHostPort` 사용이 **0곳**이었다.
#   ② 겨냥 해석 — 겨누는 명령의 파일(ctl/cli/src/{health,window,stop,migrate}.rs)이
#      `resolve_target` 을 지난다.
#
# 사용: scripts/check-server-target.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
서버 겨냥의 단일 규칙 검사

  ① 주소 조립이 otterenv::listen_addr / otterenv::base_url 을 지나는가
       format!("{host}:{port}")         →  otterenv::listen_addr(host, port)
       format!("http://{}:{}", h, p)    →  otterenv::base_url(host, port)

  ② 겨누는 명령(health·window·stop·migrate)이 resolve_target 을 지나는가

  지나가는 것: otterenv/src/host.rs (조립을 정의하는 쪽 — join_host_port 가 여기 있다) · 시험 파일 · 주석
USAGE
  exit 0
fi

source scripts/lib/rs-src.sh
fail=0

n_files=$(find rust/crates -name '*.rs' -not -path '*/target/*' | wc -l | tr -d ' ')
if [[ "$n_files" -eq 0 ]]; then
  echo "검사할 Rust 소스가 없습니다 (rust/crates/**/*.rs) — 빈 통과를 막습니다."
  exit 1
fi

HOST='[A-Za-z_.]*[Hh]ost[A-Za-z_.]*'
PORT='[A-Za-z_.]*[Pp]ort[A-Za-z_.]*'
asm=$(
  grep -rnE "\"https?://\\{[^}]*\\}:\\{|\"\\{$HOST\\}:\\{$PORT\\}\"|\"\\{\\}:\\{\\}\",[[:space:]]*$HOST,[[:space:]]*$PORT|$HOST[[:space:]]*\\+[[:space:]]*\":\"" \
    --include='*.rs' rust/crates 2>/dev/null \
    | grep -v '^rust/crates/shared/otterenv/src/host\.rs:' \
    | rs_drop_tests \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)'
)
if [[ -n "$asm" ]]; then
  echo "host:port 를 문자열로 잇는 자리가 있습니다 (FR-STR-20·21):"
  echo "$asm"
  echo
  echo "  otterenv::listen_addr(host, port) / otterenv::base_url(host, port) 를 쓰세요."
  echo "  IPv6 는 대괄호가 필요합니다 — TcpListener::bind(\"::1:9911\") 은 뜨지 않습니다."
  fail=1
fi

TARGETING=(health window stop migrate)
missing=()
for n in "${TARGETING[@]}"; do
  f="rust/crates/ctl/cli/src/$n.rs"
  if [[ ! -f "$f" ]]; then
    # M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다. 파일이 옮겨졌으면
    # 검사가 조용히 공회전하는 것이 아니라 빨개져야 한다.
    echo "겨누는 명령의 파일이 없습니다: $f — 검사가 공회전합니다."
    exit 1
  fi
  grep -q 'resolve_target' "$f" || missing+=("$f")
done
if ((${#missing[@]})); then
  echo "겨누는 명령이 ResolveTarget 을 지나지 않습니다 (FR-STR-22·23):"
  printf '  %s\n' "${missing[@]}"
  echo
  echo "  Common::resolve_target() 을 쓰세요 — 계층이 start 와 같아집니다 (FR-CFG-13)."
  echo "  지나지 않으면 server.json 의 포트를 못 보고, stop 은 남의 프로세스를 죽입니다."
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "server-target ok (주소 조립 0 · 겨누는 명령 ${#TARGETING[@]}개 전부 ResolveTarget)"
fi
exit $fail
