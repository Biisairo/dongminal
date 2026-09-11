package httpapi

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
)

// OBSERVABILITY_SRS §4.2 — 요청 ID (TC-OBS-4~8).

// TC-OBS-4: 응답에 `X-Request-Id` 가 실린다. 사용자가 화면에서 그 값을 집어
// 로그를 찾는다.
func TestReqIDInResponseHeader(t *testing.T) {
	h := reqIDMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/ping", nil))
	got := rec.Header().Get(dmlog.ReqIDHeader)
	if got == "" {
		t.Fatal("응답에 요청 ID 가 없다")
	}
	if dmlog.SanitizeReqID(got) != got {
		t.Errorf("스스로 만든 ID 가 자기 검사에 걸린다: %q", got)
	}
}

// TC-OBS-5: 클라이언트가 준 값을 쓴다.
func TestReqIDHonorsClientValue(t *testing.T) {
	var seen string
	h := reqIDMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = dmlog.ReqID(r.Context())
	}))
	req := httptest.NewRequest("GET", "/api/ping", nil)
	req.Header.Set(dmlog.ReqIDHeader, "client-abc")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if seen != "client-abc" {
		t.Errorf("핸들러가 본 ID = %q", seen)
	}
	if rec.Header().Get(dmlog.ReqIDHeader) != "client-abc" {
		t.Errorf("응답 헤더 = %q", rec.Header().Get(dmlog.ReqIDHeader))
	}
}

// TC-OBS-6: 이상한 값은 **버리고 새로 만든다.** 고쳐서 쓰지 않는 이유는 위조
// 때문이다 — 줄바꿈을 지운 값은 보낸 쪽의 것도 우리 것도 아니다.
func TestReqIDRejectsHostileValue(t *testing.T) {
	for _, bad := range []string{"new\nline", strings.Repeat("a", 200), "with space", "semi;colon"} {
		var seen string
		h := reqIDMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			seen = dmlog.ReqID(r.Context())
		}))
		req := httptest.NewRequest("GET", "/api/ping", nil)
		req.Header.Set(dmlog.ReqIDHeader, bad)
		h.ServeHTTP(httptest.NewRecorder(), req)
		if seen == bad {
			t.Errorf("이상한 값을 그대로 썼다: %q", bad)
		}
		if seen == "" {
			t.Errorf("거절했으면 새로 만들어야 한다: %q", bad)
		}
	}
}

// TC-OBS-7 — **로그 3줄 매칭.** 접근 로그와 핸들러 로그가 같은 ID 를 싣는다.
// (데몬 RPC 로그의 짝은 `toolclient` 쪽 검사가 진다.)
func TestAccessAndHandlerLogsShareID(t *testing.T) {
	var buf bytes.Buffer
	dmlog.Init(dmlog.Options{Level: "debug", Out: &buf})
	t.Cleanup(dmlog.Reset)

	h := reqIDMiddleware(loggingMiddlewareFor(nil,
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			dmlog.Warnf(r.Context(), "핸들러가 남긴 줄")
			w.WriteHeader(200)
		})))
	req := httptest.NewRequest("GET", "/api/diag", nil)
	req.Header.Set(dmlog.ReqIDHeader, "trace-1")
	h.ServeHTTP(httptest.NewRecorder(), req)

	s := buf.String()
	var withID int
	for _, line := range strings.Split(strings.TrimSpace(s), "\n") {
		if strings.Contains(line, "trace-1") {
			withID++
		}
	}
	if withID < 2 {
		t.Fatalf("같은 ID 를 든 줄이 %d개다 (접근 로그 + 핸들러 로그 = 2 이상):\n%s", withID, s)
	}
	if !strings.Contains(s, "핸들러가 남긴 줄") || !strings.Contains(s, "/api/diag") {
		t.Errorf("두 줄이 다 있어야 한다:\n%s", s)
	}
}

// TC-OBS-8: **거절된 요청에도 ID 가 있다.** 거절이야말로 사용자가 묻는
// 자리이므로, ID 미들웨어는 게이트 **앞**에 선다 (D-OBS-2).
func TestReqIDPresentOnGateRejection(t *testing.T) {
	reject := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusForbidden)
	})
	rec := httptest.NewRecorder()
	reqIDMiddleware(reject).ServeHTTP(rec, httptest.NewRequest("GET", "/api/ping", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Header().Get(dmlog.ReqIDHeader) == "" {
		t.Error("거절된 응답에 요청 ID 가 없다")
	}
}

// TC-OBS-7 (완결) — **로그 3줄이 같은 ID 로 묶인다.**
//
//	① 접근 로그       loggingMiddleware 가 요청 끝에 남기는 줄
//	② 핸들러 로그     핸들러가 그 요청 안에서 남긴 줄
//	③ 데몬 RPC 로그   `reqHub` 가 상태를 바꾸는 호출에 남기는 줄
//
// 셋을 시각으로 짐작해 묶던 것이 이 마일스톤이 고친 자리다.
func TestThreeLogLinesShareRequestID(t *testing.T) {
	var buf bytes.Buffer
	dmlog.Init(dmlog.Options{Level: "debug", Out: &buf})
	t.Cleanup(dmlog.Reset)

	srv := &Server{Deps: Deps{Tools: newFakePaneHub()}}
	h := reqIDMiddleware(loggingMiddlewareFor(nil,
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			dmlog.Warnf(r.Context(), "핸들러 판정")                              // ②
			_, _ = srv.tools(r).Create("/tmp", 80, 24, toolhub.Placement{}) // ③
			w.WriteHeader(200)
		})))
	// 경로를 고른 이유: `/api/tools` 는 핫패스 필터에 걸려 접근 로그를 남기지
	// 않는다(`shouldLogRequest`). 그 필터는 의도된 것이고, 여기서 재려는 것은
	// **로그가 남는 요청에서 셋이 묶이는가** 다.
	req := httptest.NewRequest("POST", "/api/runs", nil)
	req.Header.Set(dmlog.ReqIDHeader, "three-lines")
	h.ServeHTTP(httptest.NewRecorder(), req)

	var lines []string
	for _, l := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if strings.Contains(l, "three-lines") {
			lines = append(lines, l)
		}
	}
	if len(lines) < 3 {
		t.Fatalf("같은 ID 를 든 줄이 %d개다, 기대 3개 이상:\n%s", len(lines), buf.String())
	}
	joined := strings.Join(lines, "\n")
	for _, want := range []string{"http POST /api/runs", "핸들러 판정", "daemon rpc"} {
		if !strings.Contains(joined, want) {
			t.Errorf("%q 를 든 줄이 없다:\n%s", want, joined)
		}
	}
}

// TC-OBS-7a: 기록하지 않는 메서드도 겹을 지나 **그대로** 동작한다 (임베딩 통과).
func TestReqHubPassesThroughUnloggedMethods(t *testing.T) {
	f := newFakePaneHub()
	tool, _ := f.Create("/tmp", 80, 24, toolhub.Placement{})
	h := withReq(f, dmlog.WithReqID(context.Background(), "x1"))
	if got := h.Get(tool.ID); got == nil || got.ID != tool.ID {
		t.Fatalf("Get 이 겹을 지나며 달라졌다: %+v", got)
	}
	if len(h.List()) != len(f.List()) {
		t.Error("List 가 겹을 지나며 달라졌다")
	}
}

// TC-OBS-7b: 요청 ID 가 없으면 감싸지 않는다 — 아무것도 더하지 않는 겹을
// 만들지 않는다.
func TestWithReqSkipsWhenNoID(t *testing.T) {
	f := newFakePaneHub()
	if got := withReq(f, context.Background()); got != toolhub.ToolHub(f) {
		t.Error("ID 가 없는데 감쌌다")
	}
	if got := withReq(nil, dmlog.WithReqID(context.Background(), "x")); got != nil {
		t.Error("nil 을 감쌌다")
	}
}
