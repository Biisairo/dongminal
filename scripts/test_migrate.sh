#!/usr/bin/env bash
# scripts/migrate.sh 의 계약 검증 (USER_CHECKLIST_FIXES_SRS §4.2 / TC-MIG-1..4,6..10).
#
# 불변 조항: 운영 자산을 건드리지 않는다.
#   - DONGMINAL_HOME 은 매 케이스마다 mktemp 격리 홈
#   - BINARY 는 .test-dongminal/ 아래 (루트 ./dongminal 불가침 — 17일째 실행 중인
#     서버의 실행 파일일 수 있다)
#   - PORT 는 운영 포트(58146)가 아닌 격리 포트
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}"

TEST_BIN_DIR="${REPO_DIR}/.test-dongminal"
TEST_BIN="${TEST_BIN_DIR}/migrate-bin"
TEST_PORT="${TEST_PORT:-58199}"
mkdir -p "${TEST_BIN_DIR}"

# 루트 바이너리의 지문을 기록해 TC-MIG-10 에서 대조한다.
root_fingerprint() {
  if [ -f ./dongminal ]; then
    printf '%s|%s' "$(stat -f '%p %z' ./dongminal 2>/dev/null)" "$(shasum -a 256 ./dongminal 2>/dev/null | cut -d' ' -f1)"
  else
    echo "absent"
  fi
}
ROOT_BEFORE="$(root_fingerprint)"

PASS=0
FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2"; fi }

# 격리 홈에 v1 픽스처(region/paneId/sessions + 고아 도구 1개)를 심는다.
seed_v1() {
  local home
  home="$(mktemp -d "${TMPDIR:-/tmp}/dm-migrate-test.XXXXXX")"
  cat > "${home}/workspace.json" <<'JSON'
{
  "agentsOrder": ["100"],
  "sessions": [
    {"id":"s1","name":"work","layout":{
      "type":"region","id":"r1","activeTab":"t1",
      "tabs":[
        {"id":"t1","name":"Shell","type":"terminal","paneId":"100"},
        {"id":"t2","name":"Shell","type":"terminal","paneId":"101"}
      ]}}
  ]
}
JSON
  cat > "${home}/panes.json" <<'JSON'
[
  {"id":"100","name":"Shell #100","cwd":"/a"},
  {"id":"101","name":"Shell #101","cwd":"/b"},
  {"id":"999","name":"Shell #999","cwd":"/orphan"}
]
JSON
  echo "${home}"
}

# 격리 홈·바이너리·포트로 migrate.sh 실행.
run_migrate() {
  local home="$1"; shift
  DONGMINAL_HOME="${home}" BINARY=".test-dongminal/migrate-bin" PORT="${TEST_PORT}" \
    ./scripts/migrate.sh "$@" 2>&1
}

schema_of() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('schemaVersion','none'))" "$1" 2>/dev/null; }

echo "TC-MIG-1: --dry-run 은 계획만 출력하고 파일을 바꾸지 않는다"
H="$(seed_v1)"; BEFORE="$(cat "${H}/workspace.json")"
OUT="$(run_migrate "${H}" --dry-run)"; RC=$?
check "${RC}" "종료코드 0 (rc=${RC})"
echo "${OUT}" | grep -q "dry-run"; check "$?" "출력에 dry-run 표시"
[ "$(cat "${H}/workspace.json")" = "${BEFORE}" ]; check "$?" "workspace.json 무변경"
[ -f "${H}/panes.json" ]; check "$?" "panes.json 유지"
[ ! -f "${H}/tools.json" ]; check "$?" "tools.json 미생성"
rm -rf "${H}"

echo "TC-MIG-2: 실제 실행은 v2 로 변환하고 백업을 남긴다"
H="$(seed_v1)"
OUT="$(run_migrate "${H}")"; RC=$?
check "${RC}" "종료코드 0 (rc=${RC})"
[ "$(schema_of "${H}/workspace.json")" = "2" ]; check "$?" "schemaVersion=2"
[ -f "${H}/tools.json" ]; check "$?" "tools.json 생성"
[ ! -f "${H}/panes.json" ]; check "$?" "panes.json 이동됨"
[ -f "${H}/workspace.json.v1.bak" ]; check "$?" "workspace 백업 존재"
[ -f "${H}/panes.json.v1.bak" ]; check "$?" "panes 백업 존재"
echo "${OUT}" | grep -q "고아 도구"; check "$?" "고아 도구 폐기 보고"
rm -rf "${H}"

echo "TC-MIG-3: 낡은 바이너리를 재사용하지 않고 매번 빌드한다"
H="$(seed_v1)"
printf '#!/bin/sh\nexit 42\n' > "${TEST_BIN}"; chmod +x "${TEST_BIN}"
run_migrate "${H}" >/dev/null 2>&1; RC=$?
[ "${RC}" != "42" ]; check "$?" "스텁이 실행되지 않았다 (rc=${RC})"
[ "$(schema_of "${H}/workspace.json")" = "2" ]; check "$?" "재빌드된 바이너리로 정상 변환"
rm -rf "${H}"

echo "TC-MIG-4: 빌드 불가 시 마이그레이션을 시도하지 않고 비영 종료한다"
H="$(seed_v1)"; BEFORE="$(cat "${H}/workspace.json")"
rm -f "${TEST_BIN}"
# go 를 가려 빌드를 실패시킨다 (소스를 오염시키지 않는 유일한 방법).
env -i HOME="${HOME}" PATH=/usr/bin:/bin \
  DONGMINAL_HOME="${H}" BINARY=".test-dongminal/migrate-bin" PORT="${TEST_PORT}" \
  ./scripts/migrate.sh >/dev/null 2>&1; RC=$?
[ "${RC}" != "0" ]; check "$?" "비영 종료 (rc=${RC})"
[ "$(cat "${H}/workspace.json")" = "${BEFORE}" ]; check "$?" "workspace.json 무변경"
[ ! -f "${H}/tools.json" ]; check "$?" "tools.json 미생성"
rm -rf "${H}"

echo "TC-MIG-7/8: 서버가 포트를 점유하면 변환을 거부한다 (dry-run 은 허용)"
H="$(seed_v1)"; BEFORE="$(cat "${H}/workspace.json")"
# /api/ping 에 200 을 내는 최소 서버를 격리 포트에 띄운다.
python3 - "${TEST_PORT}" <<'PY' &
import sys, http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Length','2'); self.end_headers()
        self.wfile.write(b'ok')
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
STUB_PID=$!
for _ in $(seq 1 20); do curl -sf --max-time 1 "http://127.0.0.1:${TEST_PORT}/api/ping" >/dev/null 2>&1 && break; sleep 0.2; done
OUT="$(run_migrate "${H}")"; RC=$?
[ "${RC}" != "0" ]; check "$?" "변환 거부 (rc=${RC})"
echo "${OUT}" | grep -q "stop.sh --all"; check "$?" "정지 방법 안내"
[ "$(cat "${H}/workspace.json")" = "${BEFORE}" ]; check "$?" "workspace.json 무변경"
run_migrate "${H}" --dry-run >/dev/null 2>&1; check "$?" "dry-run 은 서버가 떠 있어도 수행된다"
[ "$(cat "${H}/workspace.json")" = "${BEFORE}" ]; check "$?" "dry-run 후에도 무변경"
kill "${STUB_PID}" 2>/dev/null; wait "${STUB_PID}" 2>/dev/null
rm -rf "${H}"

echo "TC-MIG-9: 호출자의 DONGMINAL_HOME 이 .env 값보다 우선한다"
H="$(seed_v1)"
ENV_HOME="$(grep -E '^DONGMINAL_HOME=' .env | cut -d= -f2- | sed "s|^~|${HOME}|")"
ENV_WS_BEFORE=""
[ -n "${ENV_HOME}" ] && [ -f "${ENV_HOME}/workspace.json" ] && ENV_WS_BEFORE="$(shasum -a 256 "${ENV_HOME}/workspace.json" | cut -d' ' -f1)"
run_migrate "${H}" >/dev/null 2>&1
[ "$(schema_of "${H}/workspace.json")" = "2" ]; check "$?" "지정한 홈이 변환됐다"
if [ -n "${ENV_WS_BEFORE}" ]; then
  [ "$(shasum -a 256 "${ENV_HOME}/workspace.json" | cut -d' ' -f1)" = "${ENV_WS_BEFORE}" ]
  check "$?" ".env 의 홈(${ENV_HOME}) 은 무변경"
else
  ok ".env 홈에 workspace.json 이 없어 대조 생략"
fi
rm -rf "${H}"

echo "TC-MIG-6: 스키마 미달 안내문이 실행 가능한 명령을 가리킨다"
grep -q 'scripts/migrate.sh' cmd/dongminal/main.go; check "$?" "main.go 안내문이 scripts/migrate.sh 를 가리킨다"
! grep -qE 'log\.Printf\("  [0-9]\).*[^/]dongminal migrate' cmd/dongminal/main.go; check "$?" "안내문에 PATH 의존 dongminal migrate 없음"
./scripts/migrate.sh --help >/dev/null 2>&1; check "$?" "--help 가 동작한다 (빌드 없이)"

echo "TC-MIG-10: 운영 자산 불가침"
[ "$(root_fingerprint)" = "${ROOT_BEFORE}" ]; check "$?" "루트 ./dongminal 의 권한·크기·해시 무변경"

rm -rf "${TEST_BIN_DIR}"
echo
echo "PASS=${PASS} FAIL=${FAIL}"
[ "${FAIL}" = "0" ]
