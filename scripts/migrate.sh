#!/bin/bash
# v1 → v2 엔티티 스키마 1회성 변환 (ENTITY_MODEL_RESTRUCTURE_SRS NFR-EM-2).
#
# `dongminal` 은 PATH 에 설치되지 않는다 — $DONGMINAL_HOME/bin 에 놓이는 것은
# dmctl/edit/download/detach 뿐이다. 그래서 사용자 진입점을 이 스크립트로 둔다
# (USER_CHECKLIST_FIXES_SRS FR-MIG-1..7).
set -e
cd "$(dirname "$0")/.."

# FR-MIG-7: 호출자가 명시한 값을 먼저 붙잡는다. .env 는 기본값으로만 쓴다 —
# _load_env 가 무조건 export 하므로, 이걸 하지 않으면 지정한 DONGMINAL_HOME 이
# .env 값으로 대체되어 의도하지 않은 홈을 변환한다.
_CALLER_HOME="${DONGMINAL_HOME:-}"
_CALLER_PORT="${PORT:-}"
_CALLER_BINARY="${BINARY:-}"

# Load .env safely — reads KEY=VALUE lines only, never executes shell code.
# Leading `~/` in a value is expanded to $HOME; other variable references
# like $HOME inside values are not expanded.
_load_env() {
  if [ -f .env ]; then
    while IFS='=' read -r key value; do
      case "$key" in
        ''|\#*) continue ;;
        *)
          case "$value" in
            '~'|'~/'*) value="$HOME${value#\~}" ;;
          esac
          export "$key=$value"
          ;;
      esac
    done < .env
  fi
}
_load_env

[ -n "$_CALLER_HOME" ]   && DONGMINAL_HOME="$_CALLER_HOME"
[ -n "$_CALLER_PORT" ]   && PORT="$_CALLER_PORT"
[ -n "$_CALLER_BINARY" ] && BINARY="$_CALLER_BINARY"

PORT="${PORT:-58146}"
BINARY="${BINARY:-dongminal}"
DONGMINAL_HOME="${DONGMINAL_HOME:-$HOME/.dongminal}"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    -h|--help)
      echo "Usage: $0 [--dry-run]"
      echo "  (no flag)   변환 실행 (*.v1.bak 백업 자동)"
      echo "  --dry-run   변환 내용만 출력, 파일 무변경"
      echo
      echo "DONGMINAL_HOME=$DONGMINAL_HOME"
      echo "PORT=$PORT (서버가 이 포트에서 응답하면 변환을 거부한다)"
      exit 0
      ;;
  esac
done

# ── Refuse while the server owns the home (FR-MIG-6) ─────────
# migrate.Apply 의 데몬 검사는 direct mode 로 도는 인스턴스를 잡지 못한다 —
# paned.pid 가 죽은 pid 를 가리키기 때문이다. 서버 자체를 직접 확인한다.
if [ "$DRY_RUN" = "0" ]; then
  if curl -sf --max-time 2 "http://127.0.0.1:${PORT}/api/ping" >/dev/null 2>&1; then
    echo "❌ dongminal 이 포트 ${PORT} 에서 실행 중입니다 — 변환하지 않았습니다." >&2
    echo "   서버와 데몬을 완전히 정지한 뒤 다시 실행하세요:" >&2
    echo "     ./scripts/stop.sh --all" >&2
    exit 1
  fi
fi

# ── Always build (FR-MIG-3) ──────────────────────────────────
# 존재 여부로 재사용을 결정하면, migrate 서브커맨드가 없던 바이너리가 인자를
# 무시하고 웹 서버로 부팅한다 (데몬 대기 + PTY 되살림 + 포트 충돌).
# 빌드 실패 시 set -e 로 즉시 종료한다 — 낡은 바이너리로 변환하지 않는다.
echo "Building..."
go build -o "$BINARY" ./cmd/dongminal

# ── Migrate ──────────────────────────────────────────────────
DONGMINAL_HOME="$DONGMINAL_HOME" exec ./"$BINARY" migrate "$@"
