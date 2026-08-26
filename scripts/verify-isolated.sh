#!/usr/bin/env bash
#
# 격리 인스턴스 실동작 검증 — 21항목.
#
# `dongminal stop` 을 쓰지 않는다. stop 은 홈이 아니라 **포트**로 대상을 찾으므로
# (internal/ctl/cli/proc.go killPort), --port 를 빠뜨리면 기본 포트 58146 에서
# 돌고 있는 운영 인스턴스를 SIGTERM → SIGKILL 한다. 실제로 그 사고가 났고 터미널
# 세션을 잃었다. 그래서 이 스크립트는 start 가 출력한 PID 와 격리 홈의 paned.pid
# 만 직접 kill 한다.
#
# 사용: scripts/verify-isolated.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BIN="$REPO_ROOT/dongminal"
SERVER_PID=""
ISO_HOME=""
BASE_URL=""
PASS=0
FAIL=0
FAILED_NAMES=()

# ── 정리 ──────────────────────────────────────────────────────────────
# 가드를 통과한 대상만 건드린다. 가드 전에 죽으면 아무것도 kill 하지 않는다.
cleanup() {
  local rc=$?
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$ISO_HOME" && -f "$ISO_HOME/paned.pid" ]]; then
    local dpid
    dpid="$(cat "$ISO_HOME/paned.pid" 2>/dev/null || true)"
    if [[ "$dpid" =~ ^[0-9]+$ ]]; then
      kill "$dpid" 2>/dev/null || true
    fi
  fi
  # 격리 홈은 mkdtemp 로 만들어진 임시 디렉터리다. 가드가 확인한 뒤에만 지운다.
  if [[ -n "$ISO_HOME" && "$ISO_HOME" == */dongminal-iso-* ]]; then
    rm -rf "$ISO_HOME"
  fi
  exit $rc
}
trap cleanup EXIT

say() { printf '%s\n' "$*"; }

# check <이름> <기대 HTTP 코드> <경로> [curl 추가 인자...]
# 실패해도 멈추지 않는다 — 한 번 띄운 인스턴스로 전부 훑는 것이 목적이다.
check() {
  local name="$1" want="$2" path="$3"; shift 3
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' "$@" "$BASE_URL$path" || echo 000)"
  if [[ "$got" == "$want" ]]; then
    say "  ✓ $name ($got)"
    PASS=$((PASS + 1))
  else
    say "  ✗ $name — want $want, got $got  [$path]"
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$name")
  fi
}

# ok <이름> <조건 결과 0/1> [설명]
ok() {
  local name="$1" rc="$2" detail="${3:-}"
  if [[ "$rc" == "0" ]]; then
    say "  ✓ $name"
    PASS=$((PASS + 1))
  else
    say "  ✗ $name${detail:+ — $detail}"
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$name")
  fi
}

# ── 빌드 ──────────────────────────────────────────────────────────────
say "▶ 빌드"
go build -o "$BIN" ./cmd/dongminal
say "  ✓ $BIN"

# ── 기동 ──────────────────────────────────────────────────────────────
say "▶ 격리 인스턴스 기동 (--isolated: 임시 홈 + 빈 포트)"
START_OUT="$("$BIN" start --isolated 2>&1)"
say "$START_OUT" | sed 's/^/  │ /'

SERVER_PID="$(printf '%s\n' "$START_OUT" | sed -n 's/^dongminal PID: \([0-9]*\).*/\1/p' | head -1)"
BASE_URL="$(printf '%s\n' "$START_OUT" | sed -n 's|.*running on \(http://[^ ]*\).*|\1|p' | head -1)"
ISO_HOME="$(printf '%s\n' "$START_OUT" | sed -n 's/^격리 홈: \(.*\) (자동으로.*/\1/p' | head -1)"

# ── 가드 ──────────────────────────────────────────────────────────────
# 여기서 걸리면 대상을 비우고 즉시 중단한다. 운영 인스턴스를 건드리느니
# 검증을 못 하는 편이 낫다.
if [[ -z "$SERVER_PID" || -z "$BASE_URL" || -z "$ISO_HOME" ]]; then
  SERVER_PID=""; ISO_HOME=""
  say "❌ start 출력에서 PID/URL/격리 홈을 읽지 못했다. 중단한다."
  exit 1
fi
if [[ "$BASE_URL" == *58146* ]]; then
  SERVER_PID=""; ISO_HOME=""
  say "❌ URL 이 기본 포트 58146 이다 — 운영 인스턴스일 수 있다. 중단한다."
  exit 1
fi
if [[ "$ISO_HOME" == "$HOME/.dongminal" || "$ISO_HOME" != */dongminal-iso-* ]]; then
  SERVER_PID=""; ISO_HOME=""
  say "❌ 홈이 격리 홈이 아니다: $ISO_HOME. 중단한다."
  exit 1
fi
say "  ✓ 가드 통과 — url=$BASE_URL home=$ISO_HOME pid=$SERVER_PID"

# ── 1~3. 기동 표면 ────────────────────────────────────────────────────
say "▶ 기동 표면"
ok "1. 데몬 프로세스 생존" "$(kill -0 "$SERVER_PID" 2>/dev/null && echo 0 || echo 1)"
ok "2. paned.sock 생성" "$([[ -S "$ISO_HOME/paned.sock" ]] && echo 0 || echo 1)" "$ISO_HOME/paned.sock 없음"
check "3. /api/ping" 200 "/api/ping"

# ── 4~7. 도구 (PTY + IPC 왕복) ────────────────────────────────────────
say "▶ 도구"
# GET /api/tools 는 없다 — 생성은 POST 이고 목록은 /api/state 다.
# cwd·cols·rows 는 쿼리 파라미터로 간다 (바디 아님).
TOOL_JSON="$(curl -s -X POST "$BASE_URL/api/tools?cwd=$REPO_ROOT&cols=80&rows=24" || true)"
TOOL_ID="$(printf '%s' "$TOOL_JSON" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
ok "4. 도구 생성 (PTY+IPC 왕복)" "$([[ -n "$TOOL_ID" ]] && echo 0 || echo 1)" "응답: $TOOL_JSON"

if [[ -n "$TOOL_ID" ]]; then
  STATE="$(curl -s "$BASE_URL/api/state" || true)"
  ok "5. 도구 조회 (/api/state 에 보임)" \
     "$(printf '%s' "$STATE" | grep -q "$TOOL_ID" && echo 0 || echo 1)"
  check "6. busy 조회 (데몬 busy RPC)" 200 "/api/tools/$TOOL_ID/busy"
  # 출력 조회 파라미터는 toolId 가 아니라 id 다.
  check "7. 도구 출력 조회" 200 "/api/tools/output?id=$TOOL_ID&bytes=1024"
else
  for n in 5 6 7; do
    ok "${n}. 도구 종속 검사 (생성 실패로 건너뜀)" 1
  done
fi

# ── 8. 워크스페이스 ───────────────────────────────────────────────────
say "▶ 워크스페이스·설정"
check "8. 워크스페이스 조회" 200 "/api/workspace"

# ── 9~16. git 읽기 표면 8종 ───────────────────────────────────────────
# 대상은 실제 리포여야 한다. 비-git 디렉터리는 ErrNotRepo 로 **정당하게** 404 라서
# 라우팅 누락과 구별되지 않는다 — 그러면 이 검사가 아무것도 보증하지 않는다.
say "▶ git 읽기 표면 (대상: $REPO_ROOT)"
check "9.  git status"    200 "/api/git/status?repo=$REPO_ROOT"
check "10. git log"       200 "/api/git/log?repo=$REPO_ROOT"
check "11. git refs"      200 "/api/git/refs?repo=$REPO_ROOT"
check "12. git signature" 200 "/api/git/signature?repo=$REPO_ROOT"
check "13. git policy"    200 "/api/git/policy"
check "14. git stash"     200 "/api/git/stash?repo=$REPO_ROOT"
check "15. git records"   200 "/api/git/records?repo=$REPO_ROOT"
check "16. git jobs"      200 "/api/git/jobs"

# ── 17. 없는 git 경로 ─────────────────────────────────────────────────
check "17. 없는 git 경로 404" 404 "/api/git/no-such-endpoint"

# ── 18. 상태 조회 ─────────────────────────────────────────────────────
check "18. 상태 조회 (/api/stats)" 200 "/api/stats"
check "19. 설정 조회 (/api/settings)" 200 "/api/settings"

# ── 20. index.html 이 실제로 로드하는 script 전량 ─────────────────────
# 목록을 손으로 적지 않는다 — 적는 순간 index.html 과 갈라진다.
say "▶ 정적 자산"
INDEX="$(curl -s "$BASE_URL/" || true)"
SRCS="$(printf '%s' "$INDEX" | grep -o 'src="[^"]*"' | sed 's/^src="//; s/"$//' || true)"
SRC_COUNT="$(printf '%s\n' "$SRCS" | grep -c . || true)"
BAD_SRC=0
while IFS= read -r src; do
  [[ -z "$src" ]] && continue
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/$src" || echo 000)"
  if [[ "$code" != "200" ]]; then
    say "    ✗ $src → $code"
    BAD_SRC=$((BAD_SRC + 1))
  fi
done <<< "$SRCS"
# "$n개" 로 쓰면 한글이 변수명에 붙어 unbound 가 된다 — "${n}개" 로 쓴다.
ok "20. index.html 의 script ${SRC_COUNT}개 전량 200" \
   "$([[ "$SRC_COUNT" -gt 0 && "$BAD_SRC" -eq 0 ]] && echo 0 || echo 1)" \
   "${BAD_SRC}개 실패"

# ── 21. 구 평면 경로 ──────────────────────────────────────────────────
# web/js 3폴더 재배치(묶음 E) 뒤 평면 경로는 살아 있으면 안 된다.
check "21. 구 평면 경로 /js/app.js 404" 404 "/js/app.js"

# ── 요약 ──────────────────────────────────────────────────────────────
say ""
say "────────────────────────────────────────"
say "통과 ${PASS}건 / 실패 ${FAIL}건"
if [[ "$FAIL" -gt 0 ]]; then
  say "실패 항목:"
  for n in "${FAILED_NAMES[@]}"; do say "  - $n"; done
  exit 1
fi
say "전부 통과."
