# dongminal 셸 훅 (bash). `--rcfile` 로 읽힌다 (HOST_PARITY_SRS FR-HPR-7).
#
# `BASH_ENV` 를 쓸 수 없는 이유는 그것이 **비대화형** 셸만 읽기 때문이다. 도구
# 셸은 대화형이라 이 파일이 아예 로드되지 않았고, 그동안 Linux 기본 환경에서
# `claude` 래퍼·cwd 보고·`open` 가로채기가 전부 죽어 있었다 (SRS §2.3).
#
# ── 사용자 rc ────────────────────────────────────────
# `--rcfile` 은 로그인 셸과 함께 쓸 수 없다(bash 는 로그인 셸에서 이 인자를 읽지
# 않는다). 그래서 도구 셸은 더 이상 로그인 셸이 아니고, 로그인 셸이 읽던 것을
# 여기서 **같은 순서로** 대신 읽는다 (FR-HPR-8, D-4).
#
# 실패해도 계속한다 — 사용자 rc 의 오류가 아래 훅 정의를 막으면 안 된다
# (FR-HPR-10). `zdotdir/.zshrc` 가 사용자 `.zshrc` 를 source 하는 것과 같은 자리다.
[ -f /etc/profile ] && . /etc/profile
_dm_sourced_profile=
for _dm_rc in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -f "$_dm_rc" ]; then
    . "$_dm_rc"
    _dm_sourced_profile=1
    break
  fi
done
# profile 을 하나도 읽지 못했을 때만 `.bashrc` 로 내려간다. profile 이 있으면
# 그것이 `.bashrc` 를 부를지 정하며, 그 판단은 사용자의 것이다 — 여기서 한 번 더
# 부르면 PATH 누적 같은 것이 두 번 일어난다.
[ -z "$_dm_sourced_profile" ] && [ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"
unset _dm_rc _dm_sourced_profile

# ── cwd 통지 ──────────────────────────────────────────
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
