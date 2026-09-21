package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/httpreq"
)

// SAFETY_CORRECTNESS_SRS 묶음 C (TC-SAF-5).
//
// `REQUEST_GATE_SRS` FR-RQG-14 는 *"`io.ReadAll(r.Body)` 10곳과
// `decodeJSONBody`·`fsDecode` 가 **전부** 경유한다"* 고 못박았고
// `httpreq/body.go` 머리말은 그 일을 **과거형**으로 적었다. 실제로는 일곱이
// 남아 `json.NewDecoder(r.Body).Decode` 로 무제한 스트림 디코드를 했다.
//
// 이 제품은 인증이 없고(`reqgate.go`) 게이트가 막는 것은 *출처*이지 *크기*가
// 아니다. 허용된 기기 하나가 이 종단들에 수 GB 를 흘리면 그대로 힙에 올라간다.
// attention 넷은 **에이전트 훅이 고빈도로 때리는 경로**라 더 나쁘다.

// oversized 는 기본 상한(1MiB)을 넘는 본문이다. 값 자체는 유효한 JSON 이어야
// 한다 — 상한에서 막히는 것이지 파싱에서 막히는 것이 아님을 보이려는 것이다.
func oversized() string {
	return `{"toolId":"` + strings.Repeat("x", int(httpreq.DefaultLimit)+1024) + `"}`
}

func TestBodyLimit_UnboundedEndpointsReject(t *testing.T) {
	s := &Server{}
	cases := []struct {
		name    string
		path    string
		handler func(http.ResponseWriter, *http.Request)
	}{
		{"tools/kill", "/api/tools/kill", s.apiToolKill},
		{"command-result", "/api/command-result", s.handleCommandResult},
		{"focus/claim", "/api/focus/claim", s.apiFocusClaim},
		{"focus/release", "/api/focus/release", s.apiFocusRelease},
		{"tools/attention", "/api/tools/attention", s.apiToolAttentionSet},
		{"tools/attention/clear", "/api/tools/attention/clear", s.apiToolAttentionClear},
		{"tools/activity", "/api/tools/activity", s.apiToolActivitySet},
		{"tools/background", "/api/tools/background", s.apiToolBackgroundSet},
	}
	body := oversized()
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(body))
			w := httptest.NewRecorder()
			tc.handler(w, r)

			if w.Code != http.StatusRequestEntityTooLarge {
				t.Fatalf("status=%d want 413 — 본문 상한이 없다 (FR-RQG-14)", w.Code)
			}
			if got := w.Header().Get(apierr.CodeHeader); got != apierr.CodeBodyTooBig {
				t.Errorf("%s=%q want %q", apierr.CodeHeader, got, apierr.CodeBodyTooBig)
			}
		})
	}
}

// 상한 안의 본문은 종전처럼 지나간다 (회귀 방지). 의존이 nil 인 서버이므로
// 본문을 지난 뒤의 답은 자리마다 다르다 — 여기서 재는 것은 **413 이 아니라는
// 것**뿐이다.
func TestBodyLimit_NormalBodyStillPasses(t *testing.T) {
	s := &Server{}
	cases := []struct {
		name    string
		handler func(http.ResponseWriter, *http.Request)
	}{
		{"tools/kill", s.apiToolKill},
		{"command-result", s.handleCommandResult},
		{"focus/claim", s.apiFocusClaim},
		{"focus/release", s.apiFocusRelease},
		{"tools/attention", s.apiToolAttentionSet},
		{"tools/attention/clear", s.apiToolAttentionClear},
		{"tools/activity", s.apiToolActivitySet},
		{"tools/background", s.apiToolBackgroundSet},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/x", strings.NewReader(`{"toolId":"t1"}`))
			w := httptest.NewRecorder()
			tc.handler(w, r)
			if w.Code == http.StatusRequestEntityTooLarge {
				t.Fatalf("정상 크기 본문이 413 을 받았다")
			}
		})
	}
}
