#!/usr/bin/env bash
#
# **지금 만들고 있다는 주장에 근거가 있는가** (DOC_SYNC_SRS FR-DSY-22·23).
#
# `check-srs-status.sh` 는 상태 값이 **enum 안인지**만 본다. 그 물음은 그대로 옳고,
# 이 검사는 그것을 대체하지 않고 얹는다 — 물음이 다르기 때문이다.
#
# ## 왜 필요한가
#
# 착수 시 `승인·구현중` 인 SRS 가 다섯이었고 **그중 실제로 진행 중인 것은 없었다**
# (`AUDIT-docs-gap.md` H1·H2·H3·M1):
#
#   M11_SRS · M12_SRS               대상(에이전트 GUI)이 코드에서 제거됐다 → 대체
#   AGENT_GUI_REMOVAL_SRS           전건 이행 · 가드 테스트가 영속성을 지킨다 → 구현완료
#   EDITOR_MINIMAP_TOGGLE_SRS       FR 8건 전건 확인 → 구현완료
#   M10_SRS                         남은 셋까지 닫혔다 → 구현완료
#
# 다섯 다 enum 안이었다. **라벨이 틀렸다는 사실을 잡는 검사가 없었다.**
#
# ## 무엇을 묻고, 무엇을 묻지 않는가
#
# 라벨이 **참인지**는 코드를 읽어야 안다 — 파싱이 답할 수 없는 물음이고, 억지로
# 물으면 오탐이 검사를 죽인다. 그래서 요구하는 것은 **근거를 적었는가**까지다
# (D-DSY-2): `승인·구현중` 이라면 **무엇이 남았는지** 한 줄.
#
# 그러면 둘 중 하나가 된다 — 라벨을 고치거나, 남은 일을 적거나. 둘 다 지금보다 낫다.
#
# 사용: scripts/check-srs-progress.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

INPROGRESS='승인·구현중'
MARK='^> \*\*남은 것\*\*: '

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<USAGE
"구현중" 이라는 주장의 근거 검사

  상태가 ${INPROGRESS} 인 SRS 는 **무엇이 남았는지**를 상태 줄 아래에 적는다:

    > **문서 상태**: ${INPROGRESS}
    > **남은 것**: FR-XXX-7 의 게이트. 그 밖은 닫혔다.

  라벨이 참인지는 묻지 않는다 — 코드를 읽어야 아는 일이고 파싱이 답할 수 없다.
  묻는 것은 **근거를 적었는가** 까지다 (DOC_SYNC_SRS D-DSY-2).
USAGE
  exit 0
fi

fail=0
bare=()
total=0
inprog=0

for f in docs/internal/*_SRS.md; do
  total=$((total + 1))
  grep -q "^> \*\*문서 상태\*\*: ${INPROGRESS}\$" "$f" || continue
  inprog=$((inprog + 1))
  # 상태 줄 **바로 아래 열 줄** 안에 있어야 한다. 문서 끝에 적어 두면 읽는 사람이
  # 상태를 본 자리에서 근거를 보지 못한다.
  if ! sed -n '1,14p' "$f" | grep -qE "$MARK"; then
    bare+=("$f")
  fi
done

# M6 §4-A-1: **아무것도 재지 않는 검사**를 만들지 않는다.
if [[ "$total" -lt 50 ]]; then
  echo "SRS 를 ${total}개밖에 못 읽었습니다 — 검사가 공회전합니다."
  exit 1
fi

if ((${#bare[@]})); then
  echo "\"${INPROGRESS}\" 인데 남은 것을 적지 않았습니다 (${#bare[@]}개):"
  printf '  %s\n' "${bare[@]}"
  echo
  echo "  상태 줄 바로 아래에 한 줄을 두세요:"
  echo "    > **남은 것**: <무엇이 남았는가>"
  echo
  echo "  남은 것이 없다면 상태가 틀린 것입니다 — 착수 시 다섯 전부가 그랬습니다"
  echo "  (AUDIT-docs-gap H1·H2·H3·M1)."
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  echo "srs-progress ok (SRS ${total}개 · \"${INPROGRESS}\" ${inprog}개 전부 근거가 있습니다)"
fi
exit $fail
