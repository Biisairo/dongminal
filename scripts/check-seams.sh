#!/usr/bin/env bash
#
# OS 이음매 누출 검사 (CROSS_PLATFORM_SRS FR-XBD-3, GO_REMOVAL_SRS G-16).
#
# 규칙은 하나다 — **운영체제에 의존하는 호출은 rust/crates/shared/platform 안에만
# 있다.** 그 밖에서 libc::kill 이나 /proc 경로가 보이면, 그것은 추상화를
# 우회한 것이고 다음 플랫폼에서 조용히 깨진다.
#
# sysstat 은 예외다. 자체 Reader 인터페이스로 같은 일을 이미 하고 있고,
# 그 경계가 platform 보다 앞서 있었다 (SYSTEM_STATS_SRS D-5).
#
# `#[cfg(..)]`·`cfg!(..)` 는 Go 판의 빌드 태그(`//go:build`, `_windows.go`)와 같은
# 자리라 보지 않는다 — Go 판도 빌드 태그는 보지 않았다. 실행 중에 OS 이름을 묻는
# `std::env::consts::OS` 가 Go 의 `runtime.GOOS` 자리다.
#
# 사용: scripts/check-seams.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
OS 이음매 누출 검사

  scripts/check-seams.sh

규칙은 하나다 — 운영체제에 의존하는 호출은 rust/crates/shared/platform 안에만
있다. 그 밖에서 libc::kill·/proc 경로·lsof 같은 것이 보이면 추상화를
우회한 것이고, 다음 플랫폼에서 조용히 깨진다.

검사 대상: env::consts::OS · libc::kill · libc::SIG* · nix::sys::signal ·
pre_exec/process_group/creation_flags/setsid · unix 소켓 직접 사용 · /proc 직접 읽기 ·
lsof/pgrep/ps · PTY 직접 열기 · 셸 경로 하드코딩 · 종단 파일명 하드코딩.

예외: rust/crates/shared/platform (추상화 그 자체),
      rust/crates/webserver/domain/sysstat (자체 Reader 인터페이스가 이미 있다),
      rust/crates/shared/testpath (테스트 전용 — OS 마다 다른 검사 전제를 다룬다),
      그리고 스크립트의 ALLOW_HITS 에 근거와 함께 적은 파일·항목 쌍.

설계는 docs/internal/CROSS_PLATFORM_SRS.md 참조.
EOF
  exit 0
fi

# 예외 경로 — 이 아래는 OS 를 알아도 된다. testpath 는 **테스트 전용**이며 OS 마다
# 다른 검사 전제(경로·권한·셸)를 cfg 로 다루는 것이 존재 이유다 (M8 D-A-21).
EXEMPT='^rust/crates/shared/platform/|^rust/crates/webserver/domain/sysstat/|^rust/crates/shared/testpath/'

# 파일 하나와 항목 하나의 예외 (GO_REMOVAL_SRS Q-GRM-8 — 제품 코드를 고치지 않고 표로 둔다).
#
#   edgerelay/src/tests.rs, helper/runtimebin/src/tests/chatmcp.rs — unix 소켓
#     시험이 소켓 짝(`UnixStream::pair`)과 막힌 소켓 자리를 직접 만든다.
#   shared/{edge,edgenode}/tests/go_interop.rs — ps
#     Go 참조 프로세스가 살아 있는지 본다. Go 참조를 줄 때만 도는 선택 실행 시험이다.
ALLOW_HITS=(
  "rust/crates/shared/edgerelay/src/tests.rs|unix 소켓 직접 사용"
  "rust/crates/helper/runtimebin/src/tests/chatmcp.rs|unix 소켓 직접 사용"
  "rust/crates/shared/edge/tests/go_interop.rs|ps"
  "rust/crates/shared/edgenode/tests/go_interop.rs|ps"
)

# 테스트 파일까지 검사하지 않는 패턴들이다. 테스트는 결정론을 위해 특정 셸을
# 못박는 것이 정당하다 — "$SHELL 이 무엇이든" 을 검증하는 테스트가 아니라
# "셸이 하나 떠 있을 때" 를 검증하는 테스트이기 때문이다. 그런 테스트는 POSIX
# 전용이며, Windows 보증 범위는 build·vet 과 플랫폼 독립 테스트다 (FR-XBD-4).
SKIP_TESTS_FOR='/bin/sh·/bin/bash 하드코딩'
# 시험 전용 파일(Go 의 _test.go 자리)은 scripts/lib/rs-src.sh 가 가려낸다.
source scripts/lib/rs-src.sh

# 금지 패턴. 좌변은 화면에 보일 이름, 우변은 grep -E 패턴이다.
PATTERNS=(
  "env::consts::OS|env::consts::OS"
  "libc::kill|(libc|signal)::kill(pg)?\("
  "libc::SIG*|(libc|Signal)::SIG[A-Z]"
  "nix::sys::signal|nix::sys::signal"
  "pre_exec·process_group·creation_flags·setsid|\.(pre_exec|process_group|creation_flags)\(|(libc|unistd)::setsid"
  "unix 소켓 직접 사용|Unix(Listener|Stream|Datagram)\b"
  # 종단 주소는 platform::ipc 만 만든다. 파일명을 직접 조립하면 종단
  # 표현이 바뀔 때(named pipe 등) 한쪽만 새 주소로 옮겨가 조용히 어긋난다.
  "종단 파일명 하드코딩|\"paned\.sock\""
  "/proc 직접 읽기|\"/proc/"
  "lsof|Command::new\(\"lsof\""
  "pgrep|Command::new\(\"pgrep\""
  "ps|Command::new\(\"ps\""
  "PTY 직접 열기|portable_pty|openpty|forkpty|posix_openpt"
  "/bin/sh·/bin/bash 하드코딩|\"/bin/(sh|bash|zsh)\""
)

n_files=$(find rust/crates -name '*.rs' -not -path '*/target/*' | wc -l | tr -d ' ')
if [[ "$n_files" -eq 0 ]]; then
  echo "❌ 검사할 Rust 소스가 없습니다 (rust/crates/**/*.rs) — 빈 통과를 막습니다."
  exit 1
fi

fail=0
for entry in "${PATTERNS[@]}"; do
  label="${entry%%|*}"
  pattern="${entry#*|}"
  hits=$(grep -rnE "$pattern" rust/crates --include='*.rs' 2>/dev/null \
          | grep -vE "$EXEMPT" \
          | grep -vE '^\S+:[0-9]+:\s*//')   # 주석 줄은 코드가 아니다
  if [[ "$label" == "$SKIP_TESTS_FOR" ]]; then
    hits=$(echo "$hits" | rs_drop_tests || true)
  fi
  for allow in "${ALLOW_HITS[@]}"; do
    [[ "${allow#*|}" == "$label" ]] || continue
    hits=$(echo "$hits" | grep -vF "${allow%%|*}:" || true)
  done
  if [[ -n "$hits" ]]; then
    echo "❌ $label 이(가) platform 밖에 있습니다:"
    echo "$hits" | sed 's/^/     /'
    fail=1
  fi
done

if [[ $fail -eq 0 ]]; then
  echo "✅ OS 이음매 누출 없음 — 모든 OS 의존은 rust/crates/shared/platform 안에 있습니다."
fi
exit $fail
