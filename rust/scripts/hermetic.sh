#!/usr/bin/env bash
# 격리 실행 (RUST_PORT_SRS C-RSP-1). 운영 인스턴스에 닿지 않는 환경에서 명령을 돌린다.
#
#   rust/scripts/hermetic.sh <명령> [인자...]
#
# - DONGMINAL_* 환경변수를 모두 지운다. 에이전트 탭이 물려준 DONGMINAL_PORT·TOOL_ID 가
#   운영 서버를 겨누지 않게 한다.
# - HOME 과 DONGMINAL_HOME 을 임시 디렉터리로 바꾼다. DM_HERMETIC_ROOT 가 있으면 그것을 쓴다.
# - 인자에 60147 미만의 --port 가 있으면 거절한다.
set -euo pipefail

prod_home="$HOME/.dongminal"
root="${DM_HERMETIC_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/dm-hermetic.XXXXXX")}"
mkdir -p "$root/home" "$root/dmhome"
real_root=$(cd "$root" && pwd -P)
case "$real_root" in
  "$HOME"|"$HOME/"|"$(cd "$prod_home" 2>/dev/null && pwd -P || echo /nonexistent)"*)
    echo "hermetic: 운영 홈 아래에서는 실행하지 않는다: $real_root" >&2; exit 2;;
esac

prev=""
for a in "$@"; do
  if [[ "$prev" == "--port" || "$a" == --port=* ]]; then
    p="${a#--port=}"
    if [[ "$p" =~ ^[0-9]+$ ]] && (( p < 60147 )); then
      echo "hermetic: 포트 $p 는 운영 범위다. 60147 이상을 쓴다" >&2; exit 2
    fi
  fi
  prev="$a"
done

while IFS='=' read -r k _; do
  [[ "$k" == DONGMINAL_* ]] && unset "$k"
done < <(env)

# 툴체인·빌드 캐시는 실제 HOME 의 것을 쓴다. HOME 만 바꾸면 rustup 이 임시 HOME 에 툴체인을
# 새로 내려받고 go 는 모듈 캐시를 다시 채운다.
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
if command -v go >/dev/null 2>&1; then
  export GOPATH="${GOPATH:-$(go env GOPATH)}"
  export GOMODCACHE="${GOMODCACHE:-$(go env GOMODCACHE)}"
  export GOCACHE="${GOCACHE:-$(go env GOCACHE)}"
fi
export HOME="$real_root/home"
export DONGMINAL_HOME="$real_root/dmhome"
export DONGMINAL_NO_UPDATE_CHECK=1
export DM_HERMETIC_ROOT="$real_root"
exec "$@"
