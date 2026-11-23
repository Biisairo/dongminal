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

# dongminal: claude shim 폴더를 PATH 맨 앞에 둔다 (CLAUDE_ACCOUNTS_SRS FR-CAC-83, D-CAC-24).
# shim 이 훅 인자(--settings·--plugin-dir)와 탭·폴더의 Claude 계정을 넣고 진짜 claude 를 실행한다.
# 셸 함수와 달리 사용자의 함수·alias 래핑에 덮이지 않는다. 사용자 rc 가 PATH 를 바꿀 수 있으므로
# rc 뒤에 넣고, 프롬프트마다 맨 앞이 아니면 다시 옮긴다(중복 없이).
_dm_shim_front() {
  [ -n "${DONGMINAL_HOME}" ] || return 0
  local d="${DONGMINAL_HOME}/bin/agent-shims"
  local p=":${PATH}:"
  case "$p" in ":$d:"*) return 0 ;; esac
  while case "$p" in *":$d:"*) true ;; *) false ;; esac; do
    p="${p%%":$d:"*}:${p#*":$d:"}"
  done
  p="${p#:}"
  p="${p%:}"
  PATH="$d${p:+:$p}"
}
_dm_shim_front
add-zsh-hook precmd _dm_shim_front

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
