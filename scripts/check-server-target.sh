#!/usr/bin/env bash
#
# 겨누는 자리가 **한 규칙을 지나는가** (STRUCTURE_CLEANUP_SRS FR-STR-27).
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
# `window.go` 의 주석은 이미 이렇게 적고 있었다:
#
#   FR-WIN-2: 대상 주소를 `start` 와 같은 규칙으로 정한다. 두 곳이 다르면
#   띄운 자리와 여는 자리가 어긋난다.
#
# **주석은 다음 사람을 막지 못한다.**
#
# ## 두 자리를 본다
#
#   ① 주소 조립 — `host+":"+port` 와 `fmt.Sprintf("http://%s:%s"` 꼴이 없다.
#      `net.JoinHostPort` 를 지나야 IPv6 가 산다 (`::1` 은 대괄호가 필요하다).
#      저장소 전체에 `JoinHostPort` 사용이 **0곳**이었다.
#   ② 겨냥 해석 — 겨누는 명령의 파일이 `ResolveTarget` 을 지난다.
#
# 사용: scripts/check-server-target.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
서버 겨냥의 단일 규칙 검사

  ① 주소 조립이 dmenv.ListenAddr / dmenv.BaseURL 을 지나는가
       host+":"+port                →  dmenv.ListenAddr(host, port)
       fmt.Sprintf("http://%s:%s")  →  dmenv.BaseURL(host, port)

  ② 겨누는 명령(health·window·stop·migrate)이 ResolveTarget 을 지나는가

  지나가는 것: dmenv/host.go (조립을 정의하는 쪽) · *_test.go · 주석
USAGE
  exit 0
fi

fail=0

# ── ① 주소 조립 ────────────────────────────────────────────────────────────
#
# **주석은 지나간다** — 사실을 서술한 문장에서 이름을 지우면 근거가 사라진다
# (`check-http-error.sh` 와 같은 규칙). 재는 것은 실행 코드다.
#
# 리터럴만인 문자열은 **주소가 아니라 문구다** (`"포트 %s 에서 실행 중"`). 그래서
# 판정은 `%s:%s` 처럼 **두 조각을 잇는** 꼴과, 접합에서는 **한쪽이 host 이고
# 다른 쪽이 port 인** 꼴로 좁힌다.
#
# 좁히지 않으면 `:` 로 잇는 다른 것들이 전부 걸린다 — 실측에서 오탐 11건이었다:
# 샌드박스 마운트(`m.Host+":"+m.Container`) · 도커 포트 매핑(`port+":"+port`) ·
# git 의 `<oid>:<path>` 넷 · refspec(`br+":"+br`) · 에이전트 이름. **`:` 은 주소의
# 것이 아니다.**
asm=$(
  grep -rnE '"https?://%s:%s|[A-Za-z_.]*[Hh]ost[A-Za-z_.]* *\+ *":" *\+ *[A-Za-z_.]*[Pp]ort' \
    --include='*.go' --exclude='*_test.go' internal cmd 2>/dev/null \
    | grep -v '^internal/shared/dmenv/host\.go:' \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)'
)
if [[ -n "$asm" ]]; then
  echo "host:port 를 문자열로 잇는 자리가 있습니다 (FR-STR-20·21):"
  echo "$asm"
  echo
  echo "  dmenv.ListenAddr(host, port) / dmenv.BaseURL(host, port) 를 쓰세요."
  echo "  IPv6 는 대괄호가 필요합니다 — net.Listen(\"tcp\", \"::1:9911\") 은 뜨지 않습니다."
  fail=1
fi

# ── ② 겨냥 해석 ────────────────────────────────────────────────────────────
TARGETING=(health window stop migrate)
missing=()
for n in "${TARGETING[@]}"; do
  f="internal/ctl/cli/$n.go"
  if [[ ! -f "$f" ]]; then
    # M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다. 파일이 옮겨졌으면
    # 검사가 조용히 공회전하는 것이 아니라 빨개져야 한다.
    echo "겨누는 명령의 파일이 없습니다: $f — 검사가 공회전합니다."
    exit 1
  fi
  grep -q 'ResolveTarget' "$f" || missing+=("$f")
done
if ((${#missing[@]})); then
  echo "겨누는 명령이 ResolveTarget 을 지나지 않습니다 (FR-STR-22·23):"
  printf '  %s\n' "${missing[@]}"
  echo
  echo "  Common.ResolveTarget() 을 쓰세요 — 계층이 start 와 같아집니다 (FR-CFG-13)."
  echo "  지나지 않으면 server.json 의 포트를 못 보고, stop 은 남의 프로세스를 죽입니다."
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "server-target ok (주소 조립 0 · 겨누는 명령 ${#TARGETING[@]}개 전부 ResolveTarget)"
fi
exit $fail
