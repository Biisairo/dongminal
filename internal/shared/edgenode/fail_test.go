package edgenode

import (
	"net/http"
	"strings"
	"testing"

	"dongminal/internal/shared/edge"
)

// L-1: 저장소 오류는 종류대로 가른다.
func TestStoreFailCodes(t *testing.T) {
	cases := map[error]string{
		edge.ErrNameTaken:    edge.CodeNameTaken,
		edge.ErrSaveFailed:   CodeSaveFailed,
		edge.ErrEdgeNotFound: edge.CodeNotFound,
	}
	for err, want := range cases {
		if r := storeFail(err); r.Code != want {
			t.Errorf("%v → %d %s", err, r.Status, r.Code)
		}
	}
}

// 상대의 오류는 거른 뒤에 옮긴다 — 상태는 4xx 만, 코드는 노드가 아는 것만, 문구는 제어
// 문자를 지우고 자른다.
func TestCallFailSanitizesRemote(t *testing.T) {
	cases := []struct {
		in         *edge.RemoteError
		wantStatus int
		wantCode   string
	}{
		{&edge.RemoteError{Status: 403, Code: "edge_token_invalid", Message: "x"}, 403, "edge_token_invalid"},
		{&edge.RemoteError{Status: 500, Code: "internal_error", Message: "x"}, http.StatusBadGateway, "internal_error"},
		{&edge.RemoteError{Status: 302, Code: "edge_token_invalid", Message: "x"}, http.StatusBadGateway, "edge_token_invalid"},
		{&edge.RemoteError{Status: 404, Code: "made_up\x1b[31m", Message: "x"}, 404, "edge_rejected"},
	}
	for _, c := range cases {
		if r := callFail(c.in); r.Status != c.wantStatus || r.Code != c.wantCode {
			t.Errorf("%+v → %d %s", c.in, r.Status, r.Code)
		}
	}
	r := callFail(&edge.RemoteError{Status: 400, Code: "bad_request", Message: "a\x1b[2J\r\nb" + strings.Repeat("z", 2000)})
	if strings.ContainsAny(r.Message, "\x1b\r\n") || len(r.Message) > 600 {
		t.Fatalf("문구를 거르지 않았다: %q", r.Message)
	}
}
