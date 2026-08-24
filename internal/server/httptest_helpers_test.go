package server

import (
	"io"
	"net/http"
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
	return req
}
