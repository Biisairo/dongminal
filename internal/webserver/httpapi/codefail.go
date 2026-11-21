package httpapi

import (
	"encoding/json"
	"net/http"

	"dongminal/internal/shared/httpreq"
	"dongminal/internal/shared/httpresp"
	"dongminal/internal/webserver/apierr"
)

// jsonBodyLimit 은 codeFail 방언 종단의 요청 본문 상한이다 (FR-PNW-43).
const jsonBodyLimit = 64 << 10

// codeFail 은 오류 하나다 — fs 방언과 같은 `{code,message}` (FR-PNW-42, I-7). 간선·Telegram·
// Claude 계정 API 가 같이 쓴다.
func codeFail(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set(apierr.CodeHeader, code)
	httpresp.JSON(w, status, map[string]string{"code": code, "message": msg})
}

// readJSONBody 는 본문을 상한 안에서 읽어 v 에 푼다. 실패하면 답하고 거짓이다.
func readJSONBody(w http.ResponseWriter, r *http.Request, v any) bool {
	raw, err := httpreq.Read(w, r, jsonBodyLimit)
	if err != nil {
		codeFail(w, httpreq.Status(err), apierr.BodyReadCode(err), "read body")
		return false
	}
	if len(raw) == 0 {
		raw = []byte("{}")
	}
	if err := json.Unmarshal(raw, v); err != nil {
		codeFail(w, http.StatusBadRequest, apierr.CodeInvalidJSON, "invalid json")
		return false
	}
	return true
}
