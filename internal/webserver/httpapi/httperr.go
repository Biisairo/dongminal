package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/httpreq"
)

// 핵심 표면의 오류 렌더러 (ERROR_CONTRACT_SRS 묶음 C·H).
//
// ── 본문을 바꾸지 않는다 (FR-ERR-5 / D-ERR-2) ──────────────────
//
// `architecture.md` 가 오류 본문 방언을 **공개 계약**으로 못박았다. 평문 본문을
// JSON 으로 바꾸면 그것이 곧 파괴적 변경이고, 그 통일은 `G6-4` 로 따로 기각돼 있다.
//
// 그래서 이 함수는 `http.Error` 와 **바이트 단위로 같은 본문**을 쓰고, 코드는
// `X-Error-Code` 헤더로 보낸다. 본문은 공개 계약이지만 헤더는 그 밖이다 —
// 통일을 미루면서 코드를 얻는 유일한 길이다.
//
// 요청 ID(`X-Request-Id`)는 이미 모든 응답에 실린다 (`reqIDMiddleware`). 오류
// 응답에서 그 값이 특히 쓸모 있으므로 카탈로그가 그 사실을 안내한다 (FR-ERR-6).

// httpErr 은 오류 응답 하나다. `code` 가 비면 상태에서 고른다.
//
// 코드를 상태에서 고르는 갈래를 둔 이유는 **옮기다 빠뜨린 자리**다. 빈 헤더는
// "코드가 없다" 가 아니라 "옮기다 잊었다" 로 읽히고, 그것은 클라이언트가 분기할
// 수 없는 응답을 조용히 되살린다.
func httpErr(w http.ResponseWriter, msg string, status int, code string) {
	if code == "" {
		code = apierr.CodeForStatus(status)
	}
	// 헤더를 **먼저** 세운다. `http.Error` 가 곧 WriteHeader 를 부르고, 그
	// 뒤에 얹은 헤더는 나가지 않는다.
	w.Header().Set(apierr.CodeHeader, code)
	http.Error(w, msg, status)
}

// readBodyHTTP 는 `httpErr` 방언 종단의 본문을 **상한 안에서** 읽어 디코드한다
// (SAFETY_CORRECTNESS_SRS FR-SAF-7·8).
//
// 종전에는 이 방언의 일곱 종단이 `json.NewDecoder(r.Body).Decode` 로 무제한
// 스트림 디코드를 했다 — `REQUEST_GATE_SRS` FR-RQG-14 가 *"전부 경유한다"* 고
// 못박은 뒤에도 그랬다. `decodeJSONBody`(`handlers_toolio.go`)를 그대로 쓰지
// 않는 이유는 그쪽이 toolio 방언으로 답하기 때문이다 (FR-SAF-8).
//
// **읽기 실패만 여기서 답한다.** 그 답은 자리마다 같고(413·400) 호출자가 고쳐
// 쓸 것이 없다. 디코드 실패와 필드 검증은 자리마다 문구가 다르므로 호출자에게
// 남긴다 — 돌려주는 `ok` 가 그것이다.
//
//	ok, answered := readBodyHTTP(w, r, &body)
//	if answered { return }
//	if !ok || body.ToolID == "" { httpErr(...); return }
func readBodyHTTP(w http.ResponseWriter, r *http.Request, body any) (ok, answered bool) {
	raw, err := httpreq.Read(w, r, 0)
	if err != nil {
		httpErr(w, "read body", httpreq.Status(err), bodyReadCode(err))
		return false, true
	}
	return json.Unmarshal(raw, body) == nil, false
}

// bodyReadCode 는 본문 읽기 실패의 **사유**를 코드로 옮긴다
// (SAFETY_CORRECTNESS_SRS FR-SAF-13).
//
//	이전 동작: 여섯 자리가 상태는 `httpreq.Status(err)` 로 갈라 놓고(413 또는
//	          400) 코드는 **무조건 `body_too_big`** 을 냈다. 연결이 끊긴 읽기
//	          실패가 `400 body_too_big` 으로 나갔다
//	새  동작: 상한 초과만 `body_too_big`, 나머지는 `bad_request`
//	이유:     클라이언트가 코드로 분기하는 것이 이 계약의 전부인데
//	          (`codes_core.go`) 같은 코드가 두 가지 서로 다른 일을 가리켰다.
//	          사용자에게는 "나눠 보내세요" 라는 복구 안내(`codes_doc.go`)가
//	          전달되지만 실제 원인은 연결이라 나눠 보내도 같은 결과가 온다
//
// `failRead` 로 옮기지 않은 이유: 그쪽은 코드를 **상태에서** 파생하므로
// (`fail` → `httpErr(…, "")` → `CodeForStatus(413)`) 413 이 `too_large` 가 된다.
// `body_too_big` 이 더 좁고, 그 좁음이 `codes_doc.go` 의 복구 안내를 가른다 —
// 덜 구체적인 코드로 물러설 이유가 없다.
func bodyReadCode(err error) string {
	if errors.Is(err, httpreq.ErrTooLarge) {
		return apierr.CodeBodyTooBig
	}
	return apierr.CodeBadRequest
}

// httpErrf 는 인자 순서 때문에 갈라 둔 형태다 — 문구가 여러 줄로 흐르는 자리에서
// 코드가 끝에 붙으면 읽기 어렵다.
func httpErrf(w http.ResponseWriter, code, msg string, status int) {
	httpErr(w, msg, status, code)
}
