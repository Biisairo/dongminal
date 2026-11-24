#!/usr/bin/env bash
# 상호 운용 검증 (RUST_PORT_SRS V-RSP-4, FR-RSP-20~23).
#
#   rust/interop/run.sh --go <Go 바이너리> --rust <Rust 바이너리> [--only <이름>] [--keep]
#
# Go 판과 Rust 판을 섞어 돌려 사용자가 차이를 알아채는지 본다. 모든 실행은 격리 실행이다
# (C-RSP-1): 스스로 hermetic.sh 아래에서 다시 뜨고, 포트는 60400 이상, 홈은 작업 폴더 아래다.
# 끌 때는 이 스크립트가 띄운 프로세스(작업 폴더의 바이너리로 도는 것)만 끈다.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd -P)
rust_dir=$(cd "$here/.." && pwd -P)

if [[ -z "${OTTER_INTEROP_INNER:-}" ]]; then
  export OTTER_INTEROP_INNER=1
  # 유닉스 소켓 경로 길이 상한(104) 때문에 짧은 뿌리를 쓴다.
  export OTTER_HERMETIC_ROOT="${OTTER_HERMETIC_ROOT:-$(mktemp -d /tmp/dmi.XXXXXX)}"
  exec "$rust_dir/scripts/hermetic.sh" "$0" "$@"
fi

GO_SRC="" RS_SRC="" ONLY="" KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --go) GO_SRC=$2; shift 2 ;;
    --rust) RS_SRC=$2; shift 2 ;;
    --only) ONLY=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done
[[ -x "$GO_SRC" && -x "$RS_SRC" ]] || { echo "--go 와 --rust 에 실행 파일을 준다" >&2; exit 2; }

PORT_BASE=60400
WORK="$OTTER_HERMETIC_ROOT/interop"
rm -rf "$WORK"; mkdir -p "$WORK"
for s in go rs; do mkdir -p "$WORK/bin-$s"; done
cp "$GO_SRC" "$WORK/bin-go/otterminal"; cp "$RS_SRC" "$WORK/bin-rs/otterminal"
ln -s otterminal "$WORK/bin-go/otterctl"; ln -s otterminal "$WORK/bin-rs/otterctl"
bin() { echo "$WORK/bin-$1/otterminal"; }
other() { [[ $1 == go ]] && echo rs || echo go; }

PROD_PIDS=$("$rust_dir/scripts/prod-pids.sh" | awk '{print $1}')
PIDS=()
FAILS=0 PASSES=0 CUR=""

log() { printf '%s\n' "$*" >&2; }
ok() { PASSES=$((PASSES+1)); log "  ok    $CUR: $*"; }
bad() { FAILS=$((FAILS+1)); log "  FAIL  $CUR: $*"; }
check() { local what=$1; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }

# own_kill 은 이 스크립트가 띄운 프로세스만 끈다. 운영 PID 이거나 작업 폴더 밖의
# 바이너리로 도는 프로세스면 거절한다.
own_kill() {
  local pid=$1 sig=${2:-TERM} cmd
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  if grep -qx "$pid" <<<"$PROD_PIDS"; then log "운영 PID $pid 는 끄지 않는다"; return 1; fi
  cmd=$(ps -o command= -p "$pid" 2>/dev/null) || return 0
  case "$cmd" in
    "$WORK"/*) kill -"$sig" "$pid" 2>/dev/null ;;
    *) log "작업 폴더 밖 프로세스($pid: $cmd)는 끄지 않는다"; return 1 ;;
  esac
}
wait_gone() { local i; for i in $(seq 1 100); do kill -0 "$1" 2>/dev/null || return 0; sleep 0.1; done; return 1; }
cleanup() {
  local p h
  for p in "${PIDS[@]}"; do own_kill "$p"; done
  for h in "$WORK"/s-*/home*; do [[ -f "$h/paned.pid" ]] && own_kill "$(cat "$h/paned.pid")"; done
  sleep 0.5
  for p in "${PIDS[@]}"; do kill -0 "$p" 2>/dev/null && own_kill "$p" KILL; done
  for h in "$WORK"/s-*/home*; do
    [[ -f "$h/paned.pid" ]] && kill -0 "$(cat "$h/paned.pid")" 2>/dev/null && own_kill "$(cat "$h/paned.pid")" KILL
  done
  if [[ $KEEP == 1 ]]; then log "작업 폴더: $WORK"
  elif [[ "$OTTER_HERMETIC_ROOT" == /tmp/dmi.* || "$OTTER_HERMETIC_ROOT" == /private/tmp/dmi.* ]]; then rm -rf "$OTTER_HERMETIC_ROOT"
  else rm -rf "$WORK"; fi
}
trap cleanup EXIT

# ── 서버·데몬 ──

# srv_start <side> <home> <port> [start 인자...] — 서버를 전경으로 띄우고 ping 을 기다린다.
# 띄운 pid 는 SRV_PID 에, 출력은 <home>.start.log 에 남는다.
srv_start() {
  local side=$1 home=$2 port=$3; shift 3
  mkdir -p "$home"
  [[ -f "$home/server.json" ]] || printf '{"updateCheck":false}\n' >"$home/server.json"
  OTTERMINAL_HOME="$home" "$(bin "$side")" start --foreground --port "$port" "$@" >"$home.start.log" 2>&1 &
  SRV_PID=$!; PIDS+=("$SRV_PID")
  local i
  for i in $(seq 1 150); do
    if curl -sf -o /dev/null "http://127.0.0.1:$port/api/ping"; then return 0; fi
    kill -0 "$SRV_PID" 2>/dev/null || break
    sleep 0.1
  done
  log "서버($side) 기동 실패:"; sed 's/^/    /' "$home.start.log" >&2; return 1
}
srv_stop() { own_kill "$1"; wait_gone "$1"; }
daemon_pid() { cat "$1/paned.pid" 2>/dev/null; }
daemon_stop() { local p; p=$(daemon_pid "$1"); [[ -n "$p" ]] && own_kill "$p" && wait_gone "$p"; }

api() { local port=$1 method=$2 path=$3; shift 3; curl -s -X "$method" -H 'Content-Type: application/json' "$@" "http://127.0.0.1:$port$path"; }
api_code() { local port=$1 method=$2 path=$3; shift 3; curl -s -o /dev/null -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' "$@" "http://127.0.0.1:$port$path"; }

mktool() { api "$1" POST "/api/tools?cwd=$WORK&cols=100&rows=30" | jq -r .id; }
tool_out() { api "$1" GET "/api/tools/output?id=$2&strip=1"; }
tool_in() { api "$1" POST /api/tools/input -d "$(jq -nc --arg id "$2" --arg t "$3" '{id:$id,text:$t,execute:true}')" >/dev/null; }

# saw <port> <tool> <표시> [횟수] — 도구 출력에 표시가 횟수 이상 보일 때까지 기다린다.
saw() {
  local port=$1 tool=$2 mark=$3 n=${4:-1} i c
  for i in $(seq 1 100); do
    c=$(tool_out "$port" "$tool" | grep -o "$mark" | wc -l | tr -d ' ')
    (( c >= n )) && return 0
    sleep 0.1
  done
  return 1
}
# roundtrip <port> <tool> <표시> — 셸이 명령을 실행해 표시를 낸다(에코 + 결과 = 2번).
roundtrip() { tool_in "$1" "$2" "echo $3"; saw "$1" "$2" "$3" 2; }
# shell_pid <port> <tool> — 셸의 $$ 를 읽는다.
shell_pid() {
  local m="SP$RANDOM"
  tool_in "$1" "$2" "echo $m=\$\$="
  saw "$1" "$2" "$m=[0-9][0-9]*=" 1 || return 1
  tool_out "$1" "$2" | grep -o "$m=[0-9][0-9]*=" | tail -1 | cut -d= -f2
}

put_workspace() {
  local port=$1 body=$2 rev
  rev=$(curl -s -D - -o /dev/null "http://127.0.0.1:$port/api/workspace" | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r')
  api_code "$port" PUT /api/workspace -H "If-Match: ${rev:-0}" -d "$body"
}
ws_with() { # ws_with <tool...> — 창 하나에 도구마다 탭 하나
  local tabs="" i=0 t
  for t in "$@"; do i=$((i+1)); tabs+="${tabs:+,}{\"id\":\"tab$i\",\"name\":\"T$i\",\"toolId\":\"$t\",\"type\":\"terminal\",\"nameSource\":\"manual\"}"; done
  printf '{"schemaVersion":2,"activeWindow":"w1","windows":[{"id":"w1","name":"메인","focusedPane":"p1","layout":{"type":"pane","id":"p1","activeTab":"tab1","tabs":[%s]}}]}' "$tabs"
}

# dm <side> <home> <tool> <인자...> — 그 판의 otterctl 을 도구 셸 안에서 부른 것처럼 부른다.
# stdout·stderr·종료 코드를 한 덩어리로 낸다.
dm() {
  local side=$1 home=$2 tool=$3; shift 3
  local out err rc
  out=$(mktemp); err=$(mktemp)
  OTTERMINAL_HOME="$home" OTTERMINAL_TOOL_ID="$tool" "$WORK/bin-$side/otterctl" "$@" </dev/null >"$out" 2>"$err"; rc=$?
  # 조용한 시간(quietMs)은 부른 시각에 따라 다르다.
  { printf -- '--stdout--\n'; cat "$out"; printf -- '--stderr--\n'; cat "$err"; printf -- '--exit %s--\n' "$rc"; } |
    sed -E 's/quietMs([=":]+)[0-9]+/quietMs\1N/g'

  rm -f "$out" "$err"
}

# same <설명> <go 쪽 파일> <rs 쪽 파일>
same() {
  if diff -u "$2" "$3" >"$2.diff" 2>&1; then ok "$1"; else bad "$1"; sed 's/^/      /' "$2.diff" | head -40 >&2; fi
}

# ── 시나리오 ──

# FR-RSP-21: 같은 서버에 Go otterctl 과 Rust otterctl 을 붙여 출력이 같은가. 서버는 두 판 모두.
sc_otterctl_cross() {
  local srv port home t1 t2 d
  for srv in go rs; do
    d="$SDIR/$srv"; mkdir -p "$d"; home="$SDIR/home-$srv"
    [[ $srv == rs ]] && port=$((PORT_BASE + 2)) || port=$((PORT_BASE + 1))
    srv_start "$srv" "$home" "$port" || { bad "서버($srv) 기동"; continue; }
    t1=$(mktool "$port"); t2=$(mktool "$port")
    check "[$srv 서버] workspace 저장" test "$(put_workspace "$port" "$(ws_with "$t1" "$t2")")" = 200
    saw "$port" "$t1" '.' 1; saw "$port" "$t2" '.' 1; sleep 1
    local -a cmds=(
      "who-am-i" "who-am-i --json" "list-workspace" "list-workspace --json" "list-workspace --tab T2"
      "status" "status --json" "status --at $t2" "list-groups" "list-groups --json" "edges" "edges --json"
      "run status" "run status --json" "account list" "statusline" "bogus-action" "send-input" "status --at nosuch"
      "read-screen --at $t2 --bytes 200" "read-output --at $t2 --bytes 50" "help"
    )
    local c i=0
    for c in "${cmds[@]}"; do
      i=$((i+1))
      # shellcheck disable=SC2086
      dm go "$home" "$t1" $c >"$d/$i.go"; dm rs "$home" "$t1" $c >"$d/$i.rs"
      same "[$srv 서버] otterctl $c" "$d/$i.go" "$d/$i.rs"
    done
    # 쓰는 명령: 두 판이 같은 결과를 내고 서버 상태에 같은 효과를 낸다.
    dm go "$home" "$t1" send-input --at "$t2" --execute "echo GOIN" >"$d/si.go"
    dm rs "$home" "$t1" send-input --at "$t2" --execute "echo RSIN" >"$d/si.rs"
    same "[$srv 서버] otterctl send-input 출력" "$d/si.go" "$d/si.rs"
    check "[$srv 서버] Go otterctl 입력이 셸에 닿음" saw "$port" "$t2" GOIN 2
    check "[$srv 서버] Rust otterctl 입력이 셸에 닿음" saw "$port" "$t2" RSIN 2
    dm go "$home" "$t1" rename-tab --at tab2 go-name >"$d/rn.go"
    local n1; n1=$(dm go "$home" "$t1" list-workspace --json)
    dm rs "$home" "$t1" rename-tab --at tab2 go-name >"$d/rn.rs"
    local n2; n2=$(dm rs "$home" "$t1" list-workspace --json)
    same "[$srv 서버] otterctl rename-tab 출력" "$d/rn.go" "$d/rn.rs"
    check "[$srv 서버] rename-tab 효과가 같다" test "$n1" = "$n2"
    srv_stop "$SRV_PID"; daemon_stop "$home"
  done
}

# FR-RSP-21 (서버↔데몬): 한 판의 데몬에 다른 판의 서버(--server-only)가 붙는다.
sc_daemon_cross() {
  local d dsrv ssrv home port t sp1 sp2
  for d in go rs; do
    dsrv=$d; ssrv=$(other "$d"); home="$SDIR/home-$d"; port=$((PORT_BASE + 10))
    srv_start "$dsrv" "$home" "$port" || { bad "서버($dsrv) 기동"; continue; }
    local dp; dp=$(daemon_pid "$home")
    t=$(mktool "$port")
    check "[$dsrv 데몬+$dsrv 서버] 왕복" roundtrip "$port" "$t" "MARK1$d"
    sp1=$(shell_pid "$port" "$t")
    srv_stop "$SRV_PID"
    srv_start "$ssrv" "$home" "$port" --server-only || { bad "서버($ssrv) --server-only 기동"; daemon_stop "$home"; continue; }
    sed -n 1,3p "$home.start.log" | sed 's/^/      start: /' >&2
    check "[$dsrv 데몬+$ssrv 서버] 데몬 pid 그대로" test "$(daemon_pid "$home")" = "$dp"
    check "[$dsrv 데몬+$ssrv 서버] /api/state 에 도구" eval "api $port GET /api/state | grep -q $t"
    check "[$dsrv 데몬+$ssrv 서버] 이전 출력 보존" saw "$port" "$t" "MARK1$d" 2
    check "[$dsrv 데몬+$ssrv 서버] 왕복" roundtrip "$port" "$t" "MARK2$d"
    sp2=$(shell_pid "$port" "$t")
    check "[$dsrv 데몬+$ssrv 서버] 같은 셸($sp1)" test -n "$sp1" -a "$sp1" = "$sp2"
    local t2; t2=$(mktool "$port")
    check "[$dsrv 데몬+$ssrv 서버] 새 도구 왕복" roundtrip "$port" "$t2" "MARK3$d"
    check "[$dsrv 데몬+$ssrv 서버] busy 조회 200" test "$(api_code "$port" GET "/api/tools/$t/busy")" = 200
    # health: 두 판 모두 섞인 인스턴스를 살아 있다고 보고, 데몬 판 비교는 자기 지문 기준이다 —
    # 데몬과 같은 판의 CLI 는 "그대로", 다른 판의 CLI 는 "바뀌었습니다" 가 맞다.
    local s out
    for s in go rs; do
      out=$(OTTERMINAL_HOME="$home" "$(bin "$s")" health --port "$port" 2>&1); local rc=$?
      check "[$dsrv 데몬+$ssrv 서버] $s health 종료 0" test "$rc" = 0
      if [[ $s == "$dsrv" ]]; then
        check "[$dsrv 데몬+$ssrv 서버] $s health: 데몬 코드 그대로" grep -q '데몬 코드 그대로' <<<"$out"
      else
        check "[$dsrv 데몬+$ssrv 서버] $s health: 데몬 코드가 바뀌었다" grep -q '데몬 코드가 바뀌었습니다' <<<"$out"
      fi
    done
    srv_stop "$SRV_PID"; daemon_stop "$home"
  done
}

# install_snapshot <home> <바이너리 폴더> — 데몬이 설치하는 것(bin/ 등)의 목록·링크 대상·내용 해시.
install_snapshot() {
  local home=$1 live=$2 f
  (cd "$home" && find bin ext tool-home -print 2>/dev/null | sort | while read -r f; do
    if [[ -L "$f" ]]; then printf 'L %s -> %s\n' "$f" "$(readlink "$f")"
    elif [[ -d "$f" ]]; then printf 'D %s %s\n' "$f" "$(stat -f %Lp "$f")"
    else printf 'F %s %s %s\n' "$f" "$(stat -f %Lp "$f")" "$(sed "s#$home#HOME#g; s#$live#LIVE#g" "$f" | shasum | cut -c1-16)"; fi
  done) | sed "s#$home#HOME#g; s#$live#LIVE#g"
}

# FR-RSP-22 (start 경로): 같은 자리의 바이너리를 다른 판으로 바꾸고 `start` 하면 데몬이
# 세션을 유지하며 교체된다. Go→Rust(전환)와 Rust→Go(되돌리기).
sc_handover() {
  local from to home port live t dp sp1 sp2 b0 b1 pair
  # 같은 판끼리의 교체(go→go, rs→rs)는 대조군이다. 채팅 방처럼 교체에서 무엇이 남는지는
  # 대조군과 같아야 한다.
  for pair in go:rs rs:go go:go rs:rs; do
    from=${pair%:*}; to=${pair#*:}; home="$SDIR/home-$from-$to"; port=$((PORT_BASE + 20))
    live="$SDIR/live-$from-$to"; mkdir -p "$live"
    cp "$(bin "$from")" "$live/otterminal.new"; mv "$live/otterminal.new" "$live/otterminal"
    mkdir -p "$home"; printf '{"updateCheck":false}\n' >"$home/server.json"
    OTTERMINAL_HOME="$home" "$live/otterminal" start --foreground --port "$port" >"$home.start1.log" 2>&1 &
    SRV_PID=$!; PIDS+=("$SRV_PID")
    local i; for i in $(seq 1 150); do curl -sf -o /dev/null "http://127.0.0.1:$port/api/ping" && break; sleep 0.1; done
    dp=$(daemon_pid "$home"); b0=$(cat "$home/paned.build" 2>/dev/null)
    t=$(mktool "$port")
    check "[${from}→$to] 교체 전 왕복" roundtrip "$port" "$t" "BEFORE$from"
    sp1=$(shell_pid "$port" "$t")
    api "$port" POST /api/chat/create -d '{"name":"keep-room","purpose":"handover"}' >/dev/null
    srv_stop "$SRV_PID"
    cp "$(bin "$to")" "$live/otterminal.new"; mv "$live/otterminal.new" "$live/otterminal"
    OTTERMINAL_HOME="$home" "$live/otterminal" start --foreground --port "$port" >"$home.start2.log" 2>&1 &
    SRV_PID=$!; PIDS+=("$SRV_PID")
    for i in $(seq 1 300); do curl -sf -o /dev/null "http://127.0.0.1:$port/api/ping" && break; kill -0 "$SRV_PID" 2>/dev/null || break; sleep 0.1; done
    sed 's/^/      start: /' "$home.start2.log" | head -8 >&2
    b1=$(cat "$home/paned.build" 2>/dev/null)
    check "[${from}→$to] 데몬 pid 그대로($dp)" test "$(daemon_pid "$home")" = "$dp"
    check "[${from}→$to] 데몬이 새 판으로 돈다" eval "ps -o command= -p $dp | grep -q -- '--handover-fd'"
    if [[ $from != "$to" ]]; then
      check "[${from}→$to] 데몬 지문이 바뀜(${b0}→$b1)" test "$b0" != "$b1"
    fi
    check "[${from}→$to] 이전 출력 보존" saw "$port" "$t" "BEFORE$from" 2
    check "[${from}→$to] 교체 뒤 왕복" roundtrip "$port" "$t" "AFTER$to"
    sp2=$(shell_pid "$port" "$t")
    check "[${from}→$to] 같은 셸($sp1)" test -n "$sp1" -a "$sp1" = "$sp2"
    api "$port" GET /api/chat | jq -c '[.rooms[]|{name,purpose,kind}]' >"$SDIR/rooms-$from-$to"
    install_snapshot "$home" "$live" >"$SDIR/install-$from-$to"
    srv_stop "$SRV_PID"; daemon_stop "$home"
  done
  same "교체 뒤 채팅 방: go→rs 와 go→go" "$SDIR/rooms-go-go" "$SDIR/rooms-go-rs"
  same "교체 뒤 채팅 방: rs→go 와 rs→rs" "$SDIR/rooms-rs-rs" "$SDIR/rooms-rs-go"
  same "교체 뒤 채팅 방: go→go 와 rs→rs" "$SDIR/rooms-go-go" "$SDIR/rooms-rs-rs"
  # 교체 뒤 홈의 설치물(헬퍼 링크·셸 훅·에이전트 자산)이 새 판을 처음부터 띄운 것과 같다.
  same "교체 뒤 설치물: go→rs 와 rs→rs" "$SDIR/install-rs-rs" "$SDIR/install-go-rs"
  same "교체 뒤 설치물: rs→go 와 go→go" "$SDIR/install-go-go" "$SDIR/install-rs-go"
  # 교체를 알리는 start 출력: 바뀐 판의 start 가 같은 말을 한다.
  local f
  for f in go-rs rs-go go-go rs-rs; do
    sed -E 's/^time=[^ ]+ //; s#/[^ "]*/s-handover/home-[a-z-]+#HOME#g; s/pid=[0-9]+/pid=N/g; /otterminal starting on/q' "$SDIR/home-$f.start2.log" >"$SDIR/norm-$f"
  done
  same "교체 start 출력: go→rs(Rust start) 와 rs→go(Go start)" "$SDIR/norm-rs-go" "$SDIR/norm-go-rs"
  same "교체 start 출력: rs→rs 와 go→go" "$SDIR/norm-go-go" "$SDIR/norm-rs-rs"
}

# FR-RSP-20: 한 판이 쓴 홈을 다른 판이 읽는다. 서버·데몬을 모두 내렸다가 다른 판으로 띄운다.
sc_home_files() {
  local first second home port d
  for first in go rs; do
    second=$(other "$first"); home="$SDIR/home-$first"; port=$((PORT_BASE + 30)); d="$SDIR/$first"; mkdir -p "$d"
    srv_start "$first" "$home" "$port" || { bad "서버($first) 기동"; continue; }
    local t; t=$(mktool "$port")
    put_workspace "$port" "$(ws_with "$t")" >/dev/null
    put_workspace "$port" "$(ws_with "$t" "$t")" >/dev/null
    api "$port" PUT /api/settings -d '{"theme":"light","fontSize":15,"terminal":{"scrollback":5000}}' >/dev/null
    api "$port" PUT /api/edges/node -d "{\"enabled\":false,\"port\":$((PORT_BASE + 31)),\"bind\":\"127.0.0.1\",\"name\":\"node-$first\",\"advertise\":\"127.0.0.1\"}" >/dev/null
    local p
    for p in /api/workspace /api/workspace/revisions /api/settings /api/edges /api/claude-accounts /api/access; do
      api "$port" GET "$p" >"$d/$(tr / _ <<<"$p").1"
    done
    srv_stop "$SRV_PID"; daemon_stop "$home"
    (cd "$home" && find . -type f ! -name '*.log' ! -name '*.sock' | sort | xargs shasum) >"$d/files.1"
    srv_start "$second" "$home" "$port" || { bad "서버($second) 기동"; continue; }
    for p in /api/workspace /api/workspace/revisions /api/settings /api/edges /api/claude-accounts /api/access; do
      api "$port" GET "$p" >"$d/$(tr / _ <<<"$p").2"
      local n="$d/$(tr / _ <<<"$p")"
      # 시각·온라인 목록처럼 매번 바뀌는 값은 같은 판끼리도 다르다 — 정규화하지 않고 jq 로 고정 필드만 본다.
      case "$p" in
        /api/workspace/revisions) jq -S '.generations|map(.gen,.bytes)' "$n.1" >"$n.a"; jq -S '.generations|map(.gen,.bytes)' "$n.2" >"$n.b" ;;
        /api/edges) jq -S '.node|del(.listening)' "$n.1" >"$n.a"; jq -S '.node|del(.listening)' "$n.2" >"$n.b" ;;
        *) cp "$n.1" "$n.a"; cp "$n.2" "$n.b" ;;
      esac
      same "[$first 가 쓰고 $second 가 읽음] GET $p" "$n.a" "$n.b"
    done
    check "[${first}→$second] 다른 판의 workspace 를 고칠 수 있다" test "$(put_workspace "$port" "$(ws_with "$t")")" = 200
    srv_stop "$SRV_PID"; daemon_stop "$home"
    # 읽기만 한 뒤 처음 판으로 돌아와도 그대로 읽힌다(되돌리기).
    srv_start "$first" "$home" "$port" || { bad "서버($first) 재기동"; continue; }
    check "[${first}→${second}→$first] workspace 세대 목록 읽힘" test "$(api_code "$port" GET /api/workspace/revisions)" = 200
    check "[${first}→${second}→$first] 설정 유지" eval "api $port GET /api/settings | jq -e '.theme==\"light\"' >/dev/null"
    srv_stop "$SRV_PID"; daemon_stop "$home"
  done
  # 같은 요청열이 남기는 파일이 바이트 단위로 같은가(다른 판이 그대로 읽는 근거).
  local f
  for f in workspace.json settings.json server.json edges.json; do
    local a="$SDIR/home-go/$f" b="$SDIR/home-rs/$f"
    [[ -f "$a" || -f "$b" ]] || continue
    sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/UUID/g; s/"name": *"node-(go|rs)"/"name":"node-X"/' "$a" >"$SDIR/go.$f" 2>/dev/null
    sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/UUID/g; s/"name": *"node-(go|rs)"/"name":"node-X"/' "$b" >"$SDIR/rs.$f" 2>/dev/null
    same "같은 요청열의 $f 내용" "$SDIR/go.$f" "$SDIR/rs.$f"
  done
  # 백업·복원: 한 판의 backup 을 다른 판이 restore 한다.
  local s
  for s in go rs; do
    local src="$SDIR/home-$s" dst="$SDIR/home-restore-$s"; mkdir -p "$dst"
    OTTERMINAL_HOME="$src" "$(bin "$s")" backup --out "$SDIR/bk-$s.zip" >"$SDIR/bk-$s.log" 2>&1
    OTTERMINAL_HOME="$dst" "$(bin "$(other "$s")")" restore --yes "$SDIR/bk-$s.zip" >"$SDIR/rs-$s.log" 2>&1
    check "[$s backup → $(other "$s") restore] 종료 0" test $? = 0
    check "[$s backup → $(other "$s") restore] workspace.json 같음" cmp -s "$src/workspace.json" "$dst/workspace.json"
  done
}

# FR-RSP-23: Go 노드와 Rust 노드가 간선을 맺고, 셋이면 망(mesh)이 이웃의 이웃을 보인다.
edge_topology() {
  local -a sides=("$@") homes ports eports spids
  local i
  for i in 0 1 2; do
    homes[i]="$SDIR/home-${sides[0]}${sides[1]}${sides[2]}-n$i"; ports[i]=$((PORT_BASE + 40 + i)); eports[i]=$((PORT_BASE + 50 + i))
    srv_start "${sides[i]}" "${homes[i]}" "${ports[i]}" || { bad "노드 ${i}(${sides[i]}) 기동"; return; }
    spids[i]=$SRV_PID
    local body code
    body=$(jq -nc --argjson p "${eports[i]}" --arg n "n$i-${sides[i]}" '{enabled:true,port:$p,bind:"127.0.0.1",name:$n,advertise:"127.0.0.1"}')
    code=$(api_code "${ports[i]}" PUT /api/edges/node -d "$body")
    check "노드 ${i}(${sides[i]}) 노드 포트 켜기" test "$code" = 200
  done
  pair() { # pair <초대 노드> <맺는 노드>
    local code r
    code=$(api "${ports[$1]}" POST /api/edges/invite -d '{}' | jq -r .code)
    r=$(api_code "${ports[$2]}" POST /api/edges/add -d "{\"code\":\"$code\"}")
    check "간선 n${1}(${sides[$1]}) 초대 → n${2}(${sides[$2]}) 맺기 200" test "$r" = 200
  }
  pair 0 1
  pair 2 1   # n1 이 n0·n2 사이를 중계한다
  linked() { api "${ports[$1]}" GET /api/edges | jq -e "[.edges[]|select(.linked)]|length==$2" >/dev/null; }
  eventually() { local j; for j in $(seq 1 100); do "$@" && return 0; sleep 0.1; done; return 1; }
  check "n0(${sides[0]}) 간선 1개 연결" eventually linked 0 1
  check "n1(${sides[1]}) 간선 2개 연결" eventually linked 1 2
  check "n2(${sides[2]}) 간선 1개 연결" eventually linked 2 1
  mesh_sees() { api "${ports[$1]}" GET /api/edges | jq -e ".mesh.nodes|map(select(.online))|length==3" >/dev/null; }
  check "n0(${sides[0]}) 망 그림에 세 노드 온라인(n2 는 n1 너머)" eventually mesh_sees 0
  check "n2(${sides[2]}) 망 그림에 세 노드 온라인" eventually mesh_sees 2
  check "n1(${sides[1]}) 망 그림에 세 노드 온라인" eventually mesh_sees 1
  # 채팅: n0 이 만든 방이 n1 너머 n2 에 보인다(중계).
  local room; room=$(api "${ports[0]}" POST /api/chat/create -d '{"name":"mesh-room","purpose":"relay"}' | jq -r .room.id)
  room_seen() { api "${ports[$1]}" GET /api/chat | jq -e --arg r "$room" '[.rooms[]|select(.id==$r)]|length==1' >/dev/null; }
  check "n0 의 방이 n1(${sides[1]}) 에 보임" eventually room_seen 1
  check "n0 의 방이 n2(${sides[2]}, 중계) 에 보임" eventually room_seen 2
  # n0 의 데몬에 다른 판의 `otterctl chat-mcp`(에이전트 참가자)를 붙여 방에 넣고, n2 의 글이
  # n1 을 건너 그 글함에 닿는지 본다 — chatsock 와이어와 망 중계를 함께 지난다.
  local mside; mside=$(other "${sides[0]}")
  local mt; mt=$(mktool "${ports[0]}")
  local fifo="$SDIR/mcp-in-${sides[0]}" mout="$SDIR/mcp-out-${sides[0]}"
  rm -f "$fifo"; mkfifo "$fifo"
  OTTERMINAL_HOME="${homes[0]}" OTTERMINAL_TOOL_ID="$mt" CLAUDE_CODE_SESSION_ID="interop-${sides[0]}" \
    "$WORK/bin-$mside/otterctl" chat-mcp <"$fifo" >"$mout" 2>&1 &
  local mpid=$!; PIDS+=("$mpid")
  exec 7>"$fifo"
  rpc() { printf '%s\n' "$1" >&7; }
  rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"interop","version":"0"}}}'
  rpc '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  rpc "$(jq -nc --arg r "$room" '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"chat_join",arguments:{room:$r}}}')"
  replied() { grep -q "\"id\":$1" "$mout"; }
  check "$mside chat-mcp 가 n0(${sides[0]}) 데몬에서 방에 들어감" eventually replied 2
  local jb sb
  jb=$(jq -nc --arg r "$room" '{room:$r}'); sb=$(jq -nc --arg r "$room" '{room:$r,text:"hello-over-mesh"}')
  r=$(api_code "${ports[2]}" POST /api/chat/join -d "$jb"); check "n2(${sides[2]}) 가 그 방에 들어감" test "$r" = 200
  r=$(api_code "${ports[2]}" POST /api/chat/send -d "$sb"); check "n2(${sides[2]}) 가 글을 씀" test "$r" = 200
  sleep 1
  rpc "$(jq -nc --arg r "$room" '{jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"chat_read",arguments:{room:$r}}}')"
  check "n2 의 글이 n1 너머 n0 의 $mside chat-mcp 글함에 닿음" eventually replied 3
  check "읽은 글에 본문이 있다" grep -q 'hello-over-mesh' "$mout"
  exec 7>&-
  own_kill "$mpid"
  local fp0; fp0=$(api "${ports[0]}" GET /api/edges | jq -c '{fp:.node.fingerprint}')
  r=$(api_code "${ports[1]}" POST /api/edges/remove -d "$fp0"); check "n1(${sides[1]}) 이 n0(${sides[0]}) 간선을 지움" test "$r" = 200
  check "n1(${sides[1]}) 이 지운 간선이 n0(${sides[0]}) 에서도 사라짐" eventually linked 0 0
  code=$(api "${ports[1]}" POST /api/edges/invite -d '{}' | jq -r .code)
  r=$(api_code "${ports[0]}" POST /api/edges/add -d "{\"code\":\"$code\"}")
  check "간선 n1(${sides[1]}) 초대 → n0(${sides[0]}) 맺기 200" test "$r" = 200
  check "다시 맺은 뒤 n0(${sides[0]}) 간선 연결" eventually linked 0 1
  for i in 0 1 2; do srv_stop "${spids[i]}"; daemon_stop "${homes[i]}"; done
}

sc_edge() {
  edge_topology go rs go   # Rust 가 가운데서 중계
  edge_topology rs go rs   # Go 가 가운데서 중계
}

# FR-RSP-20·21 (제어 CLI): 한 판의 stop·config·rollback 이 다른 판이 띄운 인스턴스·쓴 홈에
# 같은 결과를 낸다. 같은 CLI 를 Go 인스턴스와 Rust 인스턴스에 각각 대어 출력을 견준다.
norm_cli() { sed -E "s#$SDIR/[a-z0-9-]+#HOME#g; s/pid[= ][0-9]+/pid N/g; s/[0-9]{8}T?[0-9]{6}/STAMP/g"; }
sc_ctl_cross() {
  local c s home port out rc d="$SDIR/out"; mkdir -p "$d"
  for c in go rs; do
    for s in go rs; do
      home="$SDIR/stop-$c-$s"; port=$((PORT_BASE + 60))
      srv_start "$s" "$home" "$port" || { bad "서버($s) 기동"; continue; }
      local sp=$SRV_PID dp; dp=$(daemon_pid "$home")
      out=$(OTTERMINAL_HOME="$home" "$(bin "$c")" stop 2>&1); rc=$?
      printf '%s\nexit=%s\n' "$out" "$rc" | norm_cli >"$d/stop-$c-on-$s"
      check "[$c stop → $s 서버] 서버가 내려감" wait_gone "$sp"
      check "[$c stop → $s 서버] 데몬은 남음" kill -0 "$dp"
      srv_start "$s" "$home" "$port" --server-only || { bad "서버($s) 재기동"; continue; }
      sp=$SRV_PID
      out=$(OTTERMINAL_HOME="$home" "$(bin "$c")" stop --all 2>&1); rc=$?
      printf '%s\nexit=%s\n' "$out" "$rc" | norm_cli >"$d/stopall-$c-on-$s"
      check "[$c stop --all → $s] 서버가 내려감" wait_gone "$sp"
      check "[$c stop --all → $s] 데몬도 내려감" wait_gone "$dp"
    done
    same "$c stop 출력: Go 인스턴스와 Rust 인스턴스" "$d/stop-$c-on-go" "$d/stop-$c-on-rs"
    same "$c stop --all 출력: Go 인스턴스와 Rust 인스턴스" "$d/stopall-$c-on-go" "$d/stopall-$c-on-rs"
  done
  # 한 판이 쓴 홈(세대 포함)에 두 판의 config·rollback 을 대어 본다.
  for s in go rs; do
    home="$SDIR/home-$s"; port=$((PORT_BASE + 61))
    srv_start "$s" "$home" "$port" || { bad "서버($s) 기동"; continue; }
    local t; t=$(mktool "$port")
    put_workspace "$port" "$(ws_with "$t")" >/dev/null
    put_workspace "$port" "$(ws_with "$t" "$t")" >/dev/null
    put_workspace "$port" "$(ws_with "$t" "$t" "$t")" >/dev/null
    api "$port" PUT /api/settings -d '{"theme":"light"}' >/dev/null
    srv_stop "$SRV_PID"; daemon_stop "$home"
    for c in go rs; do
      for args in "config show" "config show --json" "config validate" "config get" "rollback" "rollback --file settings.json"; do
        # shellcheck disable=SC2086
        out=$(OTTERMINAL_HOME="$home" "$(bin "$c")" $args 2>&1); rc=$?
        printf '%s\nexit=%s\n' "$out" "$rc" | norm_cli | sed -E 's/[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:.+-]+/TIME/g' >"$d/${args// /_}-$c-on-$s"
      done
    done
    for args in "config show" "config show --json" "config validate" "config get" "rollback" "rollback --file settings.json"; do
      same "[$s 가 쓴 홈] $args: Go CLI 와 Rust CLI" "$d/${args// /_}-go-on-$s" "$d/${args// /_}-rs-on-$s"
    done
    # 다른 판의 CLI 로 세대를 되돌리고, 쓴 판이 다시 띄워 그 세대를 읽는다.
    c=$(other "$s")
    local want; want=$(cat "$home/workspace.json.bak.1" 2>/dev/null)
    OTTERMINAL_HOME="$home" "$(bin "$c")" rollback --gen 1 >"$d/rb-$c-on-$s" 2>&1
    check "[$c rollback → $s 홈] 종료 0" test $? = 0
    check "[$c rollback → $s 홈] workspace.json 이 1세대" test "$(cat "$home/workspace.json")" = "$want"
    srv_start "$s" "$home" "$port" || { bad "서버($s) 재기동"; continue; }
    check "[$c rollback → $s 서버] 되돌린 workspace 를 읽음" eval "api $port GET /api/workspace | jq -e '.windows[0].layout.tabs|length==2' >/dev/null"
    srv_stop "$SRV_PID"; daemon_stop "$home"
  done
}

SCENARIOS=(otterctl_cross daemon_cross handover home_files ctl_cross edge)
for sc in "${SCENARIOS[@]}"; do
  [[ -n "$ONLY" && "$ONLY" != "$sc" && "$ONLY" != "${sc//_/-}" ]] && continue
  CUR=${sc//_/-}; SDIR="$WORK/s-$CUR"; mkdir -p "$SDIR"
  log "== $CUR"
  "sc_$sc"
done
log "같음 $PASSES, 다름 $FAILS"
[[ $FAILS == 0 ]]
