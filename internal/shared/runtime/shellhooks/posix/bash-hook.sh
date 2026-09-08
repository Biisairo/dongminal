_rt_cwd_hook() { printf '\033]777;Cwd;%s\007' "$PWD"; }
PROMPT_COMMAND="_rt_cwd_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"

# dongminal: 에이전트 완료/대기 알림 훅(--settings)과 오케스트레이션 스킬
# (--plugin-dir)을 per-invocation 으로 주입한다. 에이전트의 설정 파일을 영구 수정하지
# 않으며 dongminal 이 띄운 도구 안에서만 적용된다.
claude() {
  local s="${DONGMINAL_HOME}/bin/agent-hooks/claude.json"
  local p="${DONGMINAL_HOME}/bin/agent-plugin"
  local -a extra=()
  [ -f "$s" ] && extra+=(--settings "$s")
  [ -d "$p" ] && extra+=(--plugin-dir "$p")
  command claude "${extra[@]}" "$@"
}
codex() { command codex -c "notify=[\"${DONGMINAL_HOME}/bin/dmctl\",\"notify\",\"codex\"]" "$@"; }

# dongminal: 브라우저를 띄우는 명령을 **보고 있는 기기**로 돌린다
# (VIEWER_URL_OPEN_SRS FR-VUO-14). http/https URL 하나만 가로채고 나머지는
# 원래 명령에 그대로 넘긴다 — `open .` 이나 `open a.pdf` 를 삼키면 안 된다.
# $DONGMINAL_HOME/bin 은 PATH 의 뒤에 있어 symlink 로는 /usr/bin/open 을 덮지
# 못한다. 그래서 함수여야 한다.
_dm_url_target() {
  [ $# -eq 1 ] || return 1
  [ -x "${DONGMINAL_HOME}/bin/open-url" ] || return 1
  case "$1" in
    http://*|https://*) return 0 ;;
  esac
  return 1
}
open() {
  if _dm_url_target "$@"; then "${DONGMINAL_HOME}/bin/open-url" "$1"
  else command open "$@"; fi
}
xdg-open() {
  if _dm_url_target "$@"; then "${DONGMINAL_HOME}/bin/open-url" "$1"
  else command xdg-open "$@"; fi
}
