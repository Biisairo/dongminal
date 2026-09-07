#!/usr/bin/env bash
#
# 시간·전파 누출 검사 (EVENT_TIMER_HUB_SRS FR-GTE-1~4).
#
# 규칙은 하나다 — **앱의 모든 타이머와 모든 이벤트 채널은 두 클래스 안에만
# 있다.** 그 밖에서 setTimeout·setInterval·requestAnimationFrame·EventSource 가
# 보이면, 그것은 규약을 우회한 것이고 다음 화면에서 조용히 새어 나간다.
#
# `check-seams.sh` 와 같은 형태다. 그 파일의 주석이 남긴 이력이 이 검사가
# 필요한 이유이기도 하다 — "D1 이 이 검사를 그냥 통과해 들어온 뒤에 추가됐다".
#
# `visiblePoll` 이 이 통합의 1차 시도였고 다섯 축 중 하나만 흡수하고 멈췄다.
# 멈춘 이유가 게이트의 부재다 (SRS §2.8) — 규약은 선언으로 지켜지지 않는다.
#
# 사용: scripts/check-timers.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
시간·전파 누출 검사

  scripts/check-timers.sh

규칙은 하나다 — 앱의 모든 타이머와 이벤트 채널은 TimerHub·EventBus 안에만
있다. 그 밖의 원시 호출은 규약(visibility·낡은 응답 폐기·single-flight·백오프·
시한)을 우회하며, 어느 것이 취소되는지 알려면 파일 서른 몇 개를 열어야 한다.

검사 대상: setTimeout · setInterval · requestAnimationFrame · new EventSource

항구적 예외 — 셋뿐이고, 이 목록이 곧 "예외의 전부" 다:
  web/js/core/timer-hub.js   추상화 그 자체
  web/js/core/event-bus.js   추상화 그 자체
  web/js/ui/diag.js          진단 계층은 피진단 계층에 의존하지 않는다

이관 중에는 아래 MIGRATING 목록이 임시 예외를 든다. 남은 줄 수가 곧 진척도이며,
이관이 끝나면 그 배열은 비어야 한다 (V-9).

설계는 docs/internal/EVENT_TIMER_HUB_SRS.md 참조.
EOF
  exit 0
fi

# 항구적 예외 (FR-GTE-2 · D-3).
EXEMPT='^web/js/core/timer-hub\.js$|^web/js/core/event-bus\.js$|^web/js/ui/diag\.js$'

# 이관 중 임시 예외 (FR-GTE-4). **줄이 줄어드는 것이 진척이다.**
# 이관이 끝나면 이 배열은 비고, V-9 가 그것을 완료 판정으로 삼는다.
MIGRATING=(
)

# 금지 패턴. 좌변은 화면에 보일 이름, 우변은 grep -E 패턴이다.
PATTERNS=(
  "setTimeout|(^|[^.\w])setTimeout[[:space:]]*\("
  "setInterval|(^|[^.\w])setInterval[[:space:]]*\("
  "requestAnimationFrame|(^|[^.\w])requestAnimationFrame[[:space:]]*\("
  "EventSource|new[[:space:]]+EventSource[[:space:]]*\("
)

mig_re=''
for f in "${MIGRATING[@]+"${MIGRATING[@]}"}"; do
  esc=${f//./\\.}
  mig_re="${mig_re:+$mig_re|}^${esc}\$"
done

fail=0
for entry in "${PATTERNS[@]}"; do
  name=${entry%%|*}
  pat=${entry#*|}
  # 주석 줄은 세지 않는다 — 계약을 설명하는 문장이 위반은 아니다.
  hits=$(grep -rnE "$pat" web/js --include='*.js' 2>/dev/null \
    | grep -v '/vendor/' \
    | grep -vE ':[[:space:]]*(//|\*|/\*)' \
    | while IFS= read -r line; do
        file=${line%%:*}
        [[ "$file" =~ $EXEMPT ]] && continue
        [[ -n "$mig_re" && "$file" =~ $mig_re ]] && continue
        printf '%s\n' "$line"
      done)
  if [[ -n "$hits" ]]; then
    fail=1
    echo "✗ $name 이 TimerHub/EventBus 밖에 있다:"
    printf '%s\n' "$hits" | sed 's/^/    /'
    echo
  fi
done

left=0
for _ in "${MIGRATING[@]+"${MIGRATING[@]}"}"; do left=$((left+1)); done
if [[ $fail -eq 0 ]]; then
  if [[ $left -gt 0 ]]; then
    echo "✓ 새 위반 없음. 이관 대기 $left 파일 (V-9 는 이 값이 0 일 때 통과한다)"
  else
    echo "✓ 시간·전파가 두 클래스 안에만 있다 (V-9 통과)"
  fi
  exit 0
fi

echo "규칙: 타이머와 이벤트 채널은 TimerHub·EventBus 안에만 있다."
echo "설계: docs/internal/EVENT_TIMER_HUB_SRS.md (FR-GTE-2)"
exit 1
