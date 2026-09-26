// Package httpresp 는 성공 JSON 응답을 쓰는 한 자리다 (OPTIMIZE_REFACTOR_SRS FR-OPT-9-4).
//
// 오류 본문은 여기서 렌더하지 않는다 — 방언이 넷이고 그것이 공개 계약이다
// (`architecture.md` "오류 응답 — 방언 넷, 통일하지 않는다"). 방언 렌더러는 각자
// 이것으로 헤더·상태·인코딩만 맡긴다.
package httpresp

import (
	"encoding/json"
	"net/http"
)

// JSON 은 v 를 JSON 으로 쓴다. `json.Encoder` 의 기본(끝 개행·HTML 이스케이프)을 그대로
// 쓴다 — 종전 인라인과 바이트가 같다.
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
