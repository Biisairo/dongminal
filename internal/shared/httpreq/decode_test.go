package httpreq

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TC-RDG-3: DecodeJSON — 정상 · 빈 본문(두 선택) · 상한 초과 · 깨진 JSON (FR-RDG-5).
func TestDecodeJSON(t *testing.T) {
	type body struct {
		A string `json:"a"`
	}
	post := func(s string) *http.Request {
		return httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(s))
	}

	t.Run("정상", func(t *testing.T) {
		var v body
		fail, err := DecodeJSON(httptest.NewRecorder(), post(`{"a":"x"}`), &v, 0)
		if fail != NoFailure || err != nil || v.A != "x" {
			t.Fatalf("%v %v %+v", fail, err, v)
		}
	})
	t.Run("빈 본문은 JSON 아님", func(t *testing.T) {
		var v body
		fail, err := DecodeJSON(httptest.NewRecorder(), post(""), &v, 0)
		if fail != NotJSON || err == nil {
			t.Fatalf("%v %v", fail, err)
		}
	})
	t.Run("빈 본문을 {} 로", func(t *testing.T) {
		v := body{A: "keep"}
		fail, err := DecodeJSON(httptest.NewRecorder(), post(""), &v, 0, EmptyAsObject)
		if fail != NoFailure || err != nil || v.A != "keep" {
			t.Fatalf("%v %v %+v", fail, err, v)
		}
	})
	t.Run("상한 초과", func(t *testing.T) {
		var v body
		fail, err := DecodeJSON(httptest.NewRecorder(), post(`{"a":"`+strings.Repeat("x", 64)+`"}`), &v, 16)
		if fail != ReadFailed || !errors.Is(err, ErrTooLarge) {
			t.Fatalf("%v %v", fail, err)
		}
	})
	t.Run("깨진 JSON", func(t *testing.T) {
		var v body
		fail, err := DecodeJSON(httptest.NewRecorder(), post("{"), &v, 0, EmptyAsObject)
		if fail != NotJSON || err == nil {
			t.Fatalf("%v %v", fail, err)
		}
	})
}

// FR-RDG-6: 64 KiB 는 이름 하나다.
func TestSmallLimit(t *testing.T) {
	if SmallLimit != 64<<10 {
		t.Fatalf("SmallLimit=%d", SmallLimit)
	}
}
