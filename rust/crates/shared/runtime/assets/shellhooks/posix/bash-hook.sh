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
PROMPT_COMMAND="_dm_shim_front${PROMPT_COMMAND:+;$PROMPT_COMMAND}"

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
