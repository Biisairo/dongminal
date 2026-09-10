package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// HTTP 헬퍼: 요청 실패를 nil 역참조 패닉이 아니라 명확한 테스트 실패로 만든다.
// `resp, _ := http.Get(...)` 뒤에 `defer resp.Body.Close()` 를 붙이는 패턴은
// 요청이 실패하면 resp 가 nil 이라 패닉하고, 진짜 원인이 스택에 묻힌다.

func mustGet(t *testing.T, url string) *http.Response {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	return resp
}

func mustPost(t *testing.T, url, contentType string, body io.Reader) *http.Response {
	t.Helper()
	resp, err := http.Post(url, contentType, body)
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	return resp
}

func mustDo(t *testing.T, req *http.Request) *http.Response {
	t.Helper()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", req.Method, req.URL, err)
	}
	return resp
}

func mustNewRequest(t *testing.T, method, url string, body io.Reader) *http.Request {
	t.Helper()
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		t.Fatalf("NewRequest %s %s: %v", method, url, err)
	}
	// REQUEST_GATE_SRS FR-RQG-5: 상태 변경 요청은 JSON 이어야 한다. 본문이 없어도
	// 그렇다 — `POST /api/tools?cwd=…` 처럼 **쿼리스트링만으로 셸을 만드는** 종단이
	// 있고, 본문 유무로 예외를 두면 그 경로가 그대로 열린다.
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}

// apiTestRequest 는 `httptest.NewRequest` 와 같되 **게이트를 지날 수 있는** 요청을
// 만든다 (REQUEST_GATE_SRS).
//
// 두 가지가 다르다.
//
//  1. `Host` 가 `127.0.0.1` 이다. `httptest.NewRequest` 의 기본값은 `example.com`
//     이고, 그것은 게이트가 막으라고 있는 바로 그 모양이다 — DNS 리바인딩은
//     공격자 도메인을 127.0.0.1 로 해석시켜 브라우저가 같은 출처라고 믿게 만든다.
//  2. 상태 변경 메서드에 `Content-Type: application/json` 을 붙인다. 이것이 없으면
//     브라우저가 프리플라이트 없이 보낼 수 있는 "단순 요청" 이 되고, 게이트는
//     그것을 415 로 막는다.
//
// **게이트를 재는 검사는 이 헬퍼를 쓰지 않는다** — 그쪽은 헤더 자체가 대상이다.
func apiTestRequest(method, target string, body io.Reader) *http.Request {
	req := httptest.NewRequest(method, target, body)
	req.Host = "127.0.0.1"
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		req.Header.Set("Content-Type", "application/json")
	}
	return req
}
