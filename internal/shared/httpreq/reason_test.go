package httpreq

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
)

// QUALITY_GO_SRS TC-QG-2: Reason 은 요청 자리만 말한다 — Go 타입·구조체 이름을 싣지 않는다 (FR-QG-1·2).
func TestReason(t *testing.T) {
	type deleteReq struct {
		Paths []string `json:"paths"`
		Inner struct {
			N int `json:"n"`
		} `json:"inner"`
	}
	decode := func(s string) error {
		var v deleteReq
		return json.Unmarshal([]byte(s), &v)
	}
	cases := []struct {
		name string
		err  error
		want string
	}{
		{"형 오류", decode(`{"paths":1}`), "paths: number 값은 맞지 않다"},
		{"안쪽 형 오류", decode(`{"inner":{"n":"x"}}`), "inner.n: string 값은 맞지 않다"},
		{"맨 위 형 오류", decode(`[1]`), "array 값은 맞지 않다"},
		{"문법 오류", decode(`{`), "unexpected end of JSON input"},
		{"문법 오류 글자", decode(`{x}`), "invalid character 'x' looking for beginning of object key string"},
		{"상한 초과", ErrTooLarge, ErrTooLarge.Error()},
		{"그 밖", errors.New("read tcp 10.0.0.1:1->10.0.0.2:2: i/o timeout"), ""},
		{"없음", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := Reason(tc.err)
			if got != tc.want {
				t.Fatalf("Reason = %q, want %q", got, tc.want)
			}
			for _, leak := range []string{"deleteReq", "[]string", "Go struct", "Go value", "httpreq."} {
				if strings.Contains(got, leak) {
					t.Fatalf("Reason 에 %q 가 샌다: %q", leak, got)
				}
			}
		})
	}
}

// FR-QG-1·3: Message 는 고정 문구에 요청 자리를 잇는다. 요청 자리가 없으면 고정 문구뿐이다.
func TestMessage(t *testing.T) {
	r := httptest.NewRequest("POST", "/api/fs/delete", nil)
	var v struct {
		Paths []string `json:"paths"`
	}
	err := json.Unmarshal([]byte(`{"paths":1}`), &v)
	if got := Message(r, "본문이 JSON 이 아니다", err); got != "본문이 JSON 이 아니다: paths: number 값은 맞지 않다" {
		t.Fatalf("Message = %q", got)
	}
	if got := Message(r, "본문을 읽지 못했다", errors.New("boom")); got != "본문을 읽지 못했다" {
		t.Fatalf("Message = %q", got)
	}
}
