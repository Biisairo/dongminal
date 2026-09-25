#!/usr/bin/env bash
#
# 요청 본문의 단일 경로 (SAFETY_CORRECTNESS_SRS FR-SAF-23 · OPTIMIZE_REFACTOR_SRS FR-OPT-1-10).
#
# 요청 본문(`r.Body`)을 읽는 자리는 `httpreq` 를 지난다. 거기에 상한이 있다.
#
# 왜: `io.ReadAll(r.Body)` 가 10곳, 무제한 `json.NewDecoder(r.Body)` 가 일곱이었다
# (`httpreq/body.go` 머리말). 1MiB 를 넘는 본문을 받아 처리하고 200 을 답한 종단이
# 셋이었다. 옮긴 뒤에도 새 종단이 `r.Body` 를 직접 읽으면 같은 결손이 조용히 돌아온다.
#
# 사용: scripts/check-body-limit.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
요청 본문의 단일 경로 검사

  internal/ · cmd/ 의 비검사 Go 소스에서 `r.Body`·`req.Body` 를 지나는 자리는
  httpreq 이거나 아래 예외 등록부에 사유와 함께 있어야 한다.

    io.ReadAll(r.Body)
      →  httpreq.Read(w, r, 0)

  지나가는 것: 주석 · *_test.go · 예외 등록부
USAGE
  exit 0
fi

# ── 예외 등록부 ──
#
# 형식: `경로|줄 내용의 정규식|사유`. 정규식은 **줄 내용**에 맞춘다 — 줄 번호는
# 편집마다 흔들린다. 사유 없는 예외는 받지 않는다 (FR-SAF-23).
EXCEPTIONS=(
  'internal/webserver/httpreq/body.go|r\.Body|본문을 읽는 한 자리 자신'
  'internal/webserver/httpapi/handlers_files.go|http\.MaxBytesReader\(w, r\.Body, s\.limits\.uploadMaxBytes\)|업로드(512MiB) 상한은 실제 사고에서 배운 방어라 httpreq 를 지나지 않는다 (httpreq/body.go)'
  'internal/webserver/httpapi/handlers_lsp.go|io\.LimitReader\(r\.Body, max\+1\)|LSP 상한은 실제 사고에서 배운 방어라 httpreq 를 지나지 않는다 — 초과는 lspReadBody 가 413 으로 답한다'
)

hits=$(
  grep -rnE '\b(r|req)\.Body\b' --include='*.go' --exclude='*_test.go' internal cmd 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' || true
)

bad=""
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  file=${line%%:*}
  rest=${line#*:}
  content=${rest#*:}
  allowed=0
  for ex in "${EXCEPTIONS[@]}"; do
    ex_file=${ex%%|*}
    ex_rest=${ex#*|}
    ex_re=${ex_rest%%|*}
    if [[ "$file" == "$ex_file" ]] && grep -qE "$ex_re" <<<"$content"; then
      allowed=1
      break
    fi
  done
  (( allowed )) || bad+="$line"$'\n'
done <<<"$hits"

if [[ -n "$bad" ]]; then
  echo "요청 본문을 httpreq 없이 읽는 자리가 있습니다 (FR-SAF-23):"
  printf '%s' "$bad"
  echo
  echo "httpreq.Read(w, r, limit) 로 읽으세요. 예외라면 이 스크립트의 등록부에 사유와 함께 적습니다."
  exit 1
fi

n=$(printf '%s' "$hits" | grep -c . || true)
echo "body-limit ok — r.Body 참조 ${n}곳 전부 httpreq 또는 등록된 예외 (${#EXCEPTIONS[@]}건)"
