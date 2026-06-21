_rt_cwd_hook() { printf '\033]777;Cwd;%s\007' "$PWD"; }
PROMPT_COMMAND="_rt_cwd_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"

# dongminal: 에이전트 완료/대기를 dmctl notify 로 라우팅한다. per-invocation 주입이라
# 에이전트의 설정 파일을 영구 수정하지 않으며 dongminal pane 안에서만 적용된다.
claude() {
  local s="${DONGMINAL_HOME}/bin/agent-hooks/claude.json"
  if [ -f "$s" ]; then command claude --settings "$s" "$@"; else command claude "$@"; fi
}
codex() { command codex -c "notify=[\"${DONGMINAL_HOME}/bin/dmctl\",\"notify\",\"codex\"]" "$@"; }
