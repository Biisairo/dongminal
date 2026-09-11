#!/usr/bin/env bash
#
# SRS 상태 필드 (M5 `DOC-1`·`G8-5`).
#
# 착수 시 SRS 136개 중 상태 필드가 있는 것이 **7개**였다(94% 부재). 그리고
# 있는 것 중 하나는 **값이 틀려 있었다** — `ICON_ASSETS_SRS` 가 `승인 대기` 인데
# 실제로는 구현이 끝나 있었다.
#
# **필드 도입만으로는 부족하다.** 그래서 갱신 규약이 함께 온다:
#
#   ① 값은 enum 이다 (아래 목록)
#   ② 구현을 끝낸 커밋이 그 SRS 의 상태를 함께 고친다
#   ③ 이 린트가 enum 밖 값과 부재를 잡는다
#   ④ 보류 항목은 "제거" 또는 "가드 테스트로 봉인" 중 하나를 택한다
#
# 사용: scripts/check-srs-status.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ENUM=(초안 승인대기 승인·구현중 승인·구현완료 폐기 대체)

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<USAGE
SRS 상태 필드 검사

  docs/internal/*_SRS.md 는 전부 제목 바로 아래에 상태 한 줄을 갖는다:

    > **문서 상태**: <값>

  값은 다음 중 하나다:
    ${ENUM[*]}

  두 벌로 적지 않는다 — 한 문서에 상태 줄이 둘이면 한쪽만 고쳐진다.
USAGE
  exit 0
fi

fail=0
missing=()
bad=()
dup=()

for f in docs/internal/*_SRS.md; do
  n=$(grep -c '^> \*\*문서 상태\*\*: ' "$f" || true)
  if [[ "$n" -eq 0 ]]; then
    missing+=("$f")
    continue
  fi
  if [[ "$n" -gt 1 ]]; then
    dup+=("$f")
    continue
  fi
  v=$(grep -m1 '^> \*\*문서 상태\*\*: ' "$f" | sed 's/^> \*\*문서 상태\*\*: //')
  ok=0
  for e in "${ENUM[@]}"; do [[ "$v" == "$e" ]] && ok=1 && break; done
  [[ $ok -eq 1 ]] || bad+=("$f — \"$v\"")
done

if ((${#missing[@]})); then
  echo "상태 필드가 없습니다 (${#missing[@]}개):"
  printf '  %s\n' "${missing[@]}"
  echo "  제목 바로 아래에 넣으세요:  > **문서 상태**: 초안"
  fail=1
fi
if ((${#dup[@]})); then
  echo "상태 줄이 둘 이상입니다 (${#dup[@]}개) — 한쪽만 고쳐집니다:"
  printf '  %s\n' "${dup[@]}"
  fail=1
fi
if ((${#bad[@]})); then
  echo "enum 밖의 값입니다 (${#bad[@]}개):"
  printf '  %s\n' "${bad[@]}"
  echo "  허용: ${ENUM[*]}"
  fail=1
fi

if [[ $fail -eq 0 ]]; then
  total=$(ls docs/internal/*_SRS.md | wc -l | tr -d ' ')
  echo "srs-status ok (${total}개 전부 enum 안)"
fi
exit $fail
