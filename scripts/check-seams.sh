#!/usr/bin/env bash
#
# OS 이음매 누출 검사 (CROSS_PLATFORM_SRS FR-XBD-3).
#
# 규칙은 하나다 — **운영체제에 의존하는 호출은 internal/shared/platform 안에만
# 있다.** 그 밖에서 syscall.Kill 이나 /proc 경로가 보이면, 그것은 추상화를
# 우회한 것이고 다음 플랫폼에서 조용히 깨진다.
#
# sysstat 은 예외다. 자체 Reader 인터페이스로 같은 일을 이미 하고 있고,
# 그 경계가 platform 보다 앞서 있었다 (SYSTEM_STATS_SRS D-5).
#
# 사용: scripts/check-seams.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
OS 이음매 누출 검사

  scripts/check-seams.sh

규칙은 하나다 — 운영체제에 의존하는 호출은 internal/shared/platform 안에만
있다. 그 밖에서 syscall.Kill·/proc 경로·lsof 같은 것이 보이면 추상화를
우회한 것이고, 다음 플랫폼에서 조용히 깨진다.

검사 대상: runtime.GOOS · syscall.Kill · syscall.SIG* · syscall.Signal ·
os.FindProcess · SysProcAttr · unix 소켓 직접 사용 · /proc 직접 읽기 ·
lsof/pgrep/ps · creack/pty · 셸 경로 하드코딩.

예외: internal/shared/platform (추상화 그 자체),
      internal/webserver/domain/sysstat (자체 Reader 인터페이스가 이미 있다).

설계는 docs/internal/CROSS_PLATFORM_SRS.md 참조.
EOF
  exit 0
fi

# 예외 경로 — 이 아래는 OS 를 알아도 된다.
EXEMPT='^internal/shared/platform/|^internal/webserver/domain/sysstat/'

# 테스트 파일까지 검사하지 않는 패턴들이다. 테스트는 결정론을 위해 특정 셸을
# 못박는 것이 정당하다 — "$SHELL 이 무엇이든" 을 검증하는 테스트가 아니라
# "셸이 하나 떠 있을 때" 를 검증하는 테스트이기 때문이다. 그런 테스트는 POSIX
# 전용이며, Windows 보증 범위는 build·vet 과 플랫폼 독립 테스트다 (FR-XBD-4).
SKIP_TESTS_FOR='/bin/sh·/bin/bash 하드코딩'

# 금지 패턴. 좌변은 화면에 보일 이름, 우변은 grep -E 패턴이다.
PATTERNS=(
  "runtime.GOOS|runtime\.GOOS"
  "syscall.Kill|syscall\.Kill\("
  "syscall.SIG*|syscall\.SIG[A-Z]"
  # 아래 둘은 D1 이 이 검사를 그냥 통과해 들어온 뒤에 추가됐다
  # (WINDOWS_TEST_PARITY_SRS FR-WTP-4). os.Process.Signal 은 Windows 에서
  # Kill 외에 구현돼 있지 않아, Signal(0) 생존 확인은 조용히 늘 실패한다.
  "os.FindProcess|os\.FindProcess\("
  "syscall.Signal|syscall\.Signal\("
  "SysProcAttr|SysProcAttr"
  "unix 소켓 직접 사용|net\.(Listen|Dial|DialTimeout)\(\"unix\""
  "/proc 직접 읽기|\"/proc/"
  "lsof|exec\.Command\(\"lsof\""
  "pgrep|exec\.Command\(\"pgrep\""
  "ps|exec\.Command\(\"ps\""
  "creack/pty|creack/pty"
  "/bin/sh·/bin/bash 하드코딩|\"/bin/(sh|bash|zsh)\""
)

fail=0
for entry in "${PATTERNS[@]}"; do
  label="${entry%%|*}"
  pattern="${entry#*|}"
  hits=$(grep -rnE "$pattern" internal cmd --include='*.go' 2>/dev/null \
          | grep -vE "$EXEMPT" \
          | grep -vE '^\S+:[0-9]+:\s*//')   # 주석 줄은 코드가 아니다
  if [[ "$label" == "$SKIP_TESTS_FOR" ]]; then
    hits=$(echo "$hits" | grep -v '_test\.go:' || true)
  fi
  if [[ -n "$hits" ]]; then
    echo "❌ $label 이(가) platform 밖에 있습니다:"
    echo "$hits" | sed 's/^/     /'
    fail=1
  fi
done

if [[ $fail -eq 0 ]]; then
  echo "✅ OS 이음매 누출 없음 — 모든 OS 의존은 internal/shared/platform 안에 있습니다."
fi
exit $fail
