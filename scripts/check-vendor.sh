#!/usr/bin/env bash
#
# 제3자 자산의 판 기록이 실제 파일과 맞는지 검사한다
# (04-secops SEC-32 · CI_GATES_SRS C4).
#
# 기록만 두면 반드시 어긋난다 — 라이브러리를 갱신하는 사람은 파일을 덮어쓰지
# 표를 고치지 않는다. 그러면 취약점 공지가 나왔을 때 "우리가 그 판인가" 에
# 답할 수 없고, 그 답을 못 하는 것이 애초에 이 표를 만든 이유였다.
#
# 사용: scripts/check-vendor.sh
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

DOC=docs/internal/VENDOR_VERSIONS.md
DIR=web/vendor

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
제3자 자산 판 기록 검사

  web/vendor 의 각 파일이 docs/internal/VENDOR_VERSIONS.md 의 표에
  같은 SHA-256 앞 16자와 같은 바이트 수로 적혀 있는지 본다.

  어긋나면 표를 고친다 — 그 문서의 "갱신 절차" 를 따르면 된다.
EOF
  exit 0
fi

fail=0

for f in "$DIR"/*; do
  b="$(basename "$f")"
  h="$(shasum -a 256 "$f" | cut -c1-16)"
  sz="$(wc -c <"$f" | tr -d ' ')"
  row="$(grep -F "\`$b\`" "$DOC" || true)"
  if [[ -z "$row" ]]; then
    echo "✗ $b — 표에 없습니다. $DOC 에 줄을 더하세요."
    fail=1
    continue
  fi
  if ! grep -qF "$h" <<<"$row"; then
    echo "✗ $b — 해시가 다릅니다. 파일: ${h}…"
    fail=1
  fi
  if ! grep -qE "\| $sz \|" <<<"$row"; then
    echo "✗ $b — 바이트 수가 다릅니다. 파일: $sz"
    fail=1
  fi
done

# 반대 방향 — 표에만 있고 파일이 사라진 것.
while read -r name; do
  [[ -e "$DIR/$name" ]] || { echo "✗ $name — 표에 있는데 $DIR 에 없습니다."; fail=1; }
done < <(grep -oE '^\| `[^`]+`' "$DOC" | sed 's/^| `//;s/`$//')

if (( fail )); then
  echo
  echo "판 기록이 실제 파일과 어긋납니다 — $DOC 를 고치세요."
  exit 1
fi

echo "✓ 제3자 자산 $(ls "$DIR" | wc -l | tr -d ' ')개의 판 기록이 파일과 맞는다"
