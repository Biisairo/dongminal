export HISTFILE="$HOME/.zsh_history"
export SHELL_SESSIONS_DISABLE=1
export ZSH_COMPDUMP="$HOME/.zcompdump"
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"
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
