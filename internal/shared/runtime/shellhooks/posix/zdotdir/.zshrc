export HISTFILE="$HOME/.zsh_history"
export SHELL_SESSIONS_DISABLE=1
export ZSH_COMPDUMP="$HOME/.zcompdump"
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"

# TOOL_HISTORY_ISOLATION_SRS FR-THI-23: 이 도구만의 히스토리를 **되살린다.**
#
# 값은 서버가 정해 `DONGMINAL_HISTFILE` 로 심는다. 여기서 다시 대입하는 이유는
# 이 자리를 지나기 전에 두 번 덮이기 때문이다 — `/etc/zshrc` 가 `HISTFILE` 을
# `${ZDOTDIR:-$HOME}/.zsh_history` 로 무조건 덮고, 그다음 사용자의 `.zshrc` 가
# 자기 값을 넣을 수 있다. 그래서 **둘 다 지나간 뒤인 여기**여야 한다.
#
# 위의 1행(`$HOME/.zsh_history`)은 그대로 둔다. 그것은 서버가 심어 주지 못했을
# 때(구버전·주입 실패) `<ZDOTDIR>/.zsh_history` 로 흘러가는 것을 막는 자리다.
[ -n "$DONGMINAL_HISTFILE" ] && export HISTFILE="$DONGMINAL_HISTFILE"
_rt_cwd_hook() { printf '\033]777;Cwd;%s\007' "$PWD" }
autoload -Uz add-zsh-hook
add-zsh-hook precmd _rt_cwd_hook
add-zsh-hook chpwd _rt_cwd_hook

# dongminal: 에이전트 완료/대기 알림 훅(--settings)과 오케스트레이션 스킬
# (--plugin-dir)을 per-invocation 으로 주입한다. 에이전트의 설정 파일을 영구 수정하지
# 않으며 dongminal 이 띄운 도구 안에서만 적용된다.
# command 로 실제 바이너리를 호출하므로 함수 자기재귀가 아니다.
claude() {
  local s="${DONGMINAL_HOME}/bin/agent-hooks/claude.json"
  local p="${DONGMINAL_HOME}/bin/agent-plugin"
  local -a extra
  extra=()
  [[ -f "$s" ]] && extra+=(--settings "$s")
  [[ -d "$p" ]] && extra+=(--plugin-dir "$p")
  command claude "${extra[@]}" "$@"
}
codex() { command codex -c "notify=[\"${DONGMINAL_HOME}/bin/dmctl\",\"notify\",\"codex\"]" "$@" }
omp() {
  local h="${DONGMINAL_HOME}/bin/agent-hooks/omp-activity.mjs"
  local p="${DONGMINAL_HOME}/bin/agent-plugin"
  local -a extra=()
  [ -f "$h" ] && extra+=(--hook "$h")
  [ -d "$p" ] && extra+=(--plugin-dir "$p")
  command omp "${extra[@]}" "$@"
}

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
