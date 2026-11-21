package httpresp

import "net/http"

// CodeHeader 는 오류 코드를 싣는 응답 헤더다 (REFACTOR3_DEDUP_GO_SRS FR-RDG-1).
//
// 이름이 네 벌이었다(`apierr`·`edgenode`·`edge` 둘, 하나는 리터럴). `shared/edge` 는
// `webserver` 를 가져올 수 없어 여기 둔다 (D-RDG-1). `apierr.CodeHeader` 는 이 값을 가리킨다.
const CodeHeader = "X-Error-Code"

// Text 는 평문 방언의 본문이다. `http.Error` 와 같은 바이트로 나간다.
type Text string

// Raw 는 이미 직렬화한 JSON 본문이다. 끝 개행 없이 그대로 나간다.
type Raw []byte

// Fail 은 오류 응답의 한 문이다 (FR-RDG-2). 코드 헤더를 **먼저** 세우고 상태와 본문을 쓴다 —
// 상태를 쓴 뒤에 얹은 헤더는 나가지 않는다.
//
// 방언(평문 · `{error}` · `{code,message}` · `{error,message}` · runs 의 `{error,detail,…}`)은
// 합치지 않는다(D-RDG-2). 방언 함수는 본문을 만들어 여기로 넘긴다. body 가 [Text] 면
// 평문, [Raw] 면 그 바이트, 그 밖이면 [JSON] 과 같은 인코딩이다.
func Fail(w http.ResponseWriter, status int, code string, body any) {
	w.Header().Set(CodeHeader, code)
	switch b := body.(type) {
	case Text:
		http.Error(w, string(b), status)
	case Raw:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(b)
	default:
		JSON(w, status, body)
	}
}

// FailCode 는 `{code,message}` 방언 하나다 (FR-RDG-4). 노드 포트·간선·Telegram·Claude 계정
// API·탐색기가 같이 쓴다.
func FailCode(w http.ResponseWriter, status int, code, msg string) {
	Fail(w, status, code, map[string]string{"code": code, "message": msg})
}
