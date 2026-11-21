package runtimebin

import (
	"encoding/json"
	"fmt"
	"io"
)

// HTTP 응답 → 종료 코드 (REFACTOR3_DEDUP_GO_SRS FR-RDG-20·21).
//
// 같은 판정이 아홉 자리에 따로 적혀 있었다. 종단마다 다른 것은 셋뿐이다 — 연결 실패를
// 어떻게 말하는가, 어느 상태를 성공으로 보는가, 거절 본문을 어떻게 찍는가. 그 셋을
// exitRule 로 받고, 분기 순서와 종료 코드는 httpExit 한 자리에 둔다.

// exitRule 은 한 종단의 응답 해석이다.
type exitRule struct {
	// prefix 는 연결 실패 줄의 머리다: "<prefix>: <err>" 를 쓰고 1.
	prefix string
	// onErr 가 있으면 prefix 대신 이것이 연결 실패를 답한다. 돌려준 값이 종료 코드다.
	onErr func(stderr io.Writer, err error) int
	// ok 가 nil 이면 2xx 가 성공이다.
	ok func(status int) bool
	// refuse 는 성공이 아닌 상태를 답한다. 돌려준 값이 종료 코드다.
	refuse func(stderr io.Writer, status int, body []byte) int
}

// httpExit 는 HTTP 결과 하나를 종료 코드로 옮긴다. ok 가 참일 때만 호출자가 본문을
// 이어 읽는다 — 거짓이면 이미 답했고 code 가 그 종료 코드다(0 일 수 있다: open-url 의
// 로컬 열기).
func httpExit(status int, body []byte, err error, stderr io.Writer, r exitRule) (resp []byte, code int, ok bool) {
	if err != nil {
		if r.onErr != nil {
			return nil, r.onErr(stderr, err), false
		}
		fmt.Fprintf(stderr, "%s: %v\n", r.prefix, err)
		return nil, 1, false
	}
	accept := r.ok
	if accept == nil {
		accept = is2xx
	}
	if !accept(status) {
		return nil, r.refuse(stderr, status, body), false
	}
	return body, 0, true
}

func is2xx(status int) bool { return status >= 200 && status < 300 }

// below400 은 `/api/commands` 계열의 성공 판정이다 — 종전부터 400 미만을 성공으로 읽는다.
func below400(status int) bool { return status < 400 }

// refuseWith 는 거절을 찍고 1 로 끝나는 refuse 다.
func refuseWith(render func(w io.Writer, status int, body []byte)) func(io.Writer, int, []byte) int {
	return func(w io.Writer, status int, body []byte) int {
		render(w, status, body)
		return 1
	}
}

// apiRule 은 `{error}` 방언의 종단이다 (FR-OPT-9-2 · SHR-16).
func apiRule(path string) exitRule {
	return exitRule{prefix: "dmctl", refuse: refuseWith(func(w io.Writer, st int, b []byte) { printAPIError(w, st, path, b) })}
}

// codeRule 은 `{code,message}` 방언의 종단이다 (edge·account, FR-PNW-74).
func codeRule() exitRule {
	return exitRule{prefix: "dmctl", refuse: refuseWith(printCodeRefusal)}
}

// apiResult 는 apiRule 로 결과 하나를 옮긴다: 전송 오류는 `dmctl: <err>`, 비2xx 는
// printAPIError, 성공이면 본문과 0.
func apiResult(path string, status int, body []byte, err error, stderr io.Writer) ([]byte, int) {
	body, code, _ := httpExit(status, body, err, stderr, apiRule(path))
	return body, code
}

// rawRefusal 은 서버 본문을 그대로 stderr 에 싣는다. 이 도구의 규약 — 본문이 개행으로
// 끝나지 않으면 하나 붙인다 (DRIFT_RECLAIM_SRS FR-DRC-11).
func rawRefusal(w io.Writer, _ int, body []byte) {
	w.Write(body)
	if len(body) == 0 || body[len(body)-1] != '\n' {
		fmt.Fprintln(w)
	}
}

// refusal 은 서버 거절 본문의 세 방언 — `{error}` · runs 의 `{error,detail,…}` ·
// `{code,message}` — 을 한 번에 읽은 것이다 (FR-RDG-21).
//
// 필드를 날것으로 두고 렌더러가 자기가 쓰는 것만 푼다. 한 방언의 필드 모양이 틀렸다고
// 다른 방언의 읽기까지 실패하면 안 된다 — 렌더러가 셋이던 때의 판정이 그랬다.
type refusal struct {
	Error      json.RawMessage `json:"error"`
	Detail     json.RawMessage `json:"detail"`
	Code       json.RawMessage `json:"code"`
	Message    json.RawMessage `json:"message"`
	Unreported json.RawMessage `json:"unreported"`
	RunID      json.RawMessage `json:"runId"`
	Stale      json.RawMessage `json:"stale"`
	MemberID   json.RawMessage `json:"memberId"`
	State      json.RawMessage `json:"state"`
	Hint       json.RawMessage `json:"hint"`
}

// parseRefusal 은 본문이 JSON 객체(또는 null)일 때만 ok 다.
func parseRefusal(raw []byte) (refusal, bool) {
	var r refusal
	return r, json.Unmarshal(raw, &r) == nil
}

// takeField 는 날것 필드 하나를 dst 로 푼다. 필드가 없으면 성공이고 dst 는 그대로다.
func takeField(f json.RawMessage, dst any) bool {
	return len(f) == 0 || json.Unmarshal(f, dst) == nil
}

// printAPIError 는 `{error}` 를 풀어 보이고, 아니면 본문을 그대로 싣는다.
func printAPIError(stderr io.Writer, status int, path string, body []byte) {
	var msg string
	if r, ok := parseRefusal(body); ok && takeField(r.Error, &msg) && msg != "" {
		fmt.Fprintf(stderr, "dmctl: %s\n", msg)
		return
	}
	fmt.Fprintf(stderr, "dmctl: %s returned status %d: %s\n", path, status, body)
}

// printCodeRefusal 은 `{code,message}` 를 풀어 보인다. 상대 노드의 글자가 실리므로
// 제어 문자를 지운다.
func printCodeRefusal(w io.Writer, status int, raw []byte) {
	var code, msg string
	if r, ok := parseRefusal(raw); ok && takeField(r.Code, &code) && takeField(r.Message, &msg) && code != "" {
		fmt.Fprintf(w, "dmctl: %s: %s\n", clean(code), clean(msg))
		return
	}
	fmt.Fprintf(w, "dmctl: status %d: %s\n", status, clean(string(raw)))
}
