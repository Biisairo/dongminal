package httpreq

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"dongminal/internal/shared/dmlog"
)

// Reason 은 읽기·디코드 실패를 클라이언트에 보여도 되는 말로 옮긴다 (QUALITY_GO_SRS FR-QG-1·2).
//
// 싣는 것은 **요청 자리**뿐이다 — 클라이언트가 보낸 JSON 의 어디가 틀렸는가. 문법 오류는
// 그 문구(보낸 바이트만 말한다), 형 오류는 필드 경로(JSON 키 이름)와 받은 값의 JSON 종류다.
// 상한 초과는 [ErrTooLarge] 의 문구다. 그 밖은 빈 문자열이다.
//
//	이전: 원인 오류의 문구를 그대로 실었다 — `json: cannot unmarshal number into Go struct
//	      field fsDeleteReq.paths of type []string` 처럼 Go 의 타입·구조체 이름이 드러났다
//	새  : 그 자리의 `paths: number 값은 맞지 않다`
//	이유: P2 가 문구를 남긴 근거(FR-RDG-7 — 클라이언트가 자기 요청의 어디가 틀렸는지
//	      알아야 한다)는 요청 자리로 채워진다. 타입 이름은 그 근거에 들지 않는다
func Reason(err error) string {
	var syn *json.SyntaxError
	var typ *json.UnmarshalTypeError
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrTooLarge):
		return ErrTooLarge.Error()
	case errors.As(err, &syn):
		return syn.Error()
	case errors.As(err, &typ):
		if typ.Field == "" {
			return fmt.Sprintf("%s 값은 맞지 않다", typ.Value)
		}
		return fmt.Sprintf("%s: %s 값은 맞지 않다", typ.Field, typ.Value)
	}
	return ""
}

// Message 는 고정 문구 prefix 에 [Reason] 을 잇고, 원인 전문은 `dmlog` 로 남긴다 (FR-QG-3).
// 요청 자리가 없으면 prefix 뿐이다.
func Message(r *http.Request, prefix string, err error) string {
	dmlog.Infof(r.Context(), "body decode %s %s: %v", r.Method, r.URL.Path, err)
	if why := Reason(err); why != "" {
		return prefix + ": " + why
	}
	return prefix
}
