#!/usr/bin/env bash
#
# 요청 본문의 단일 경로 (SAFETY_CORRECTNESS_SRS FR-SAF-23 · OPTIMIZE_REFACTOR_SRS FR-OPT-1-10,
# GO_REMOVAL_SRS G-20).
#
# 요청 본문을 꺼내는 자리(`r.take_body()`·`req.into_body()`·`req.into_parts()`·`req.body_mut()`,
# Go 의 `r.Body`)는 `httpreq` 를 지난다. 거기에 상한이 있다.
#
# 왜: `io.ReadAll(r.Body)` 가 10곳, 무제한 `json.NewDecoder(r.Body)` 가 일곱이었다
# (Go 기준선 `httpreq/body.go` 머리말). 1MiB 를 넘는 본문을 받아 처리하고 200 을 답한 종단이
# 셋이었다. 옮긴 뒤에도 새 종단이 `r.Body` 를 직접 읽으면 같은 결손이 조용히 돌아온다.
#
# 사용: scripts/check-body-limit.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
요청 본문의 단일 경로 검사

  rust/crates/ 의 비검사 Rust 소스에서 요청 본문을 꺼내는 자리
  (`r.take_body()`·`req.into_body()`·`req.into_parts()`·`req.body_mut()`) 는
  같은 줄에서 httpreq 로 넘기거나 아래 예외 등록부에 사유와 함께 있어야 한다.

    r.take_body() 를 직접 모아 읽기
      →  r.read_body(limit).await   (httpreq::read)

  지나가는 것: 주석 · 시험 파일 · 같은 줄의 httpreq::read·decode_json · 예외 등록부
USAGE
  exit 0
fi

# ── 예외 등록부 ──
#
# 형식: `경로|줄 내용의 정규식|사유`. 정규식은 **줄 내용**에 맞춘다 — 줄 번호는
# 편집마다 흔들린다. 사유 없는 예외는 받지 않는다 (FR-SAF-23).
EXCEPTIONS=(
  'rust/crates/webserver/httpapi/src/serve.rs|let \(parts, body\) = req\.into_parts\(\)|요청을 Req 로 옮기는 서버 배관 — 본문을 읽지 않고 Req 에 담는다. Go 는 net/http 가 r.Body 로 같은 일을 했다'
  'rust/crates/webserver/gitapi/src/req.rs|let \(parts, body\) = req\.into_parts\(\)|요청을 git Req 로 옮기는 배관 — 본문을 읽지 않고 담는다. 읽는 것은 decode_body(httpreq) 다'
  'rust/crates/webserver/httpapi/src/serve.rs|b\.body\(r\.take_body\(\)\)|git 표면으로 요청을 그대로 넘긴다(Go s.git.ServeHTTP(w, r)) — 읽는 것은 gitapi 의 decode_body 다'
  'rust/crates/webserver/httpapi/src/multipart.rs|let mut body = r\.take_body\(\)|업로드(512MiB) 상한은 실제 사고에서 배운 방어라 httpreq 를 지나지 않는다 (httpreq 머리말)'
)

n_files=$(find rust/crates -name '*.rs' -not -path '*/target/*' | wc -l | tr -d ' ')
if [[ "$n_files" -eq 0 ]]; then
  echo "검사할 Rust 소스가 없습니다 (rust/crates/**/*.rs) — 빈 통과를 막습니다."
  exit 1
fi

source scripts/lib/rs-src.sh
hits=$(
  grep -rnE '\b(r|req|request)\.(take_body|into_body|into_parts|body_mut)\(\)' --include='*.rs' rust/crates 2>/dev/null \
    | rs_drop_tests \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)' || true
)

bad=""
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  file=${line%%:*}
  rest=${line#*:}
  content=${rest#*:}
  allowed=0
  if grep -qE 'httpreq::(read|decode_json)\(' <<<"$content"; then
    allowed=1
  fi
  for ex in "${EXCEPTIONS[@]}"; do
    (( allowed )) && break
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
  echo "httpreq::read(body, limit) 로 읽으세요. 예외라면 이 스크립트의 등록부에 사유와 함께 적습니다."
  exit 1
fi

n=$(printf '%s' "$hits" | grep -c . || true)
echo "body-limit ok — r.Body 참조 ${n}곳 전부 httpreq 또는 등록된 예외 (${#EXCEPTIONS[@]}건)"
