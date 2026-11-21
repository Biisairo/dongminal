package httpapi

import (
	"net/http"

	"dongminal/internal/shared/httpreq"
	"dongminal/internal/shared/httpresp"
	"dongminal/internal/webserver/apierr"
)

// jsonBodyLimit 은 codeFail 방언 종단의 요청 본문 상한이다 (FR-PNW-43 · REFACTOR3_DEDUP_GO_SRS FR-RDG-6).
const jsonBodyLimit = httpreq.SmallLimit

// codeFail 은 오류 하나다 — fs 방언과 같은 `{code,message}` (FR-PNW-42, I-7). 간선·Telegram·
// Claude 계정 API 가 같이 쓴다.
func codeFail(w http.ResponseWriter, status int, code, msg string) {
	httpresp.FailCode(w, status, code, msg)
}

// readJSONBody 는 본문을 상한 안에서 읽어 v 에 푼다. 실패하면 답하고 거짓이다.
func readJSONBody(w http.ResponseWriter, r *http.Request, v any) bool {
	switch fail, err := httpreq.DecodeJSON(w, r, v, jsonBodyLimit, httpreq.EmptyAsObject); fail {
	case httpreq.ReadFailed:
		codeFail(w, httpreq.Status(err), apierr.BodyReadCode(err), "read body")
		return false
	case httpreq.NotJSON:
		codeFail(w, http.StatusBadRequest, apierr.CodeInvalidJSON, "invalid json")
		return false
	}
	return true
}
