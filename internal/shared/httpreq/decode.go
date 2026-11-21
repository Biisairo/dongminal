package httpreq

import (
	"encoding/json"
	"net/http"
)

// Failure 는 JSON 본문 읽기의 실패 종류다.
type Failure int

const (
	// NoFailure 는 성공이다.
	NoFailure Failure = iota
	// ReadFailed 는 본문을 읽지 못했다는 뜻이다. 상한 초과면 원인이 [ErrTooLarge] 다.
	ReadFailed
	// NotJSON 은 본문이 v 로 풀리지 않았다는 뜻이다.
	NotJSON
)

// Empty 는 빈 본문의 처리다.
type Empty int

// EmptyAsObject 면 빈 본문을 `{}` 로 읽는다. 주지 않으면 빈 본문은 [NotJSON] 이다.
const EmptyAsObject Empty = 1

// DecodeJSON 은 본문을 상한 안에서 읽어 v 로 푼다 (REFACTOR3_DEDUP_GO_SRS FR-RDG-5).
// `limit` 이 0 이하면 [DefaultLimit] 이다.
//
// **답하지 않는다.** 실패 종류와 원인 오류를 돌려주고, 상태·코드·문구는 호출자가 자기
// 방언으로 정한다. 읽기 실패의 상태는 [Status] 가 준다.
//
// 문구 규칙 (FR-RDG-7): 읽기 실패·JSON 아님의 본문 문구에 원인 오류의 문구를 싣는
// 방언(toolio·fs·git)은 그대로 싣는다. 클라이언트가 자기 요청의 어디가 틀렸는지 알아야
// 한다 — git 디코더의 기존 설계다. 고정 문구를 쓰는 방언(평문·`{code,message}`·노드
// 포트)도 그대로다. 이 함수는 어느 쪽의 문구도 바꾸지 않는다.
func DecodeJSON(w http.ResponseWriter, r *http.Request, v any, limit int64, empty ...Empty) (Failure, error) {
	raw, err := Read(w, r, limit)
	if err != nil {
		return ReadFailed, err
	}
	if len(raw) == 0 && len(empty) > 0 && empty[0] == EmptyAsObject {
		raw = []byte("{}")
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return NotJSON, err
	}
	return NoFailure, nil
}
