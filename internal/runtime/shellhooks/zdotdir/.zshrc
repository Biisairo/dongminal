export HISTFILE="$HOME/.zsh_history"
export SHELL_SESSIONS_DISABLE=1
export ZSH_COMPDUMP="$HOME/.zcompdump"
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"
_rt_cwd_hook() { printf '\033]777;Cwd;%s\007' "$PWD" }
autoload -Uz add-zsh-hook
add-zsh-hook precmd _rt_cwd_hook
add-zsh-hook chpwd _rt_cwd_hook

# dongminal: 에이전트 완료/대기를 dmctl notify 로 라우팅한다. per-invocation 주입이라
# 에이전트의 설정 파일을 영구 수정하지 않으며 dongminal pane 안에서만 적용된다.
# command 로 실제 바이너리를 호출하므로 함수 자기재귀가 아니다.
claude() {
  local s="${DONGMINAL_HOME}/bin/agent-hooks/claude.json"
  if [ -f "$s" ]; then command claude --settings "$s" "$@"; else command claude "$@"; fi
}
codex() { command codex -c "notify=[\"${DONGMINAL_HOME}/bin/dmctl\",\"notify\",\"codex\"]" "$@" }
