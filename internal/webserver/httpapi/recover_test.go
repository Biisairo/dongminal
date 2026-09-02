package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// CODE_AUDIT_FIXES_SRS 묶음 B — 핸들러의 패닉과 그것을 잡을 그물 (V-CAF-3~6).
//
// **왜 그물이 필요한가.** `net/http` 는 핸들러의 패닉을 잡아 그 연결만 끊는다.
// 서버는 죽지 않지만 브라우저는 **아무 응답도 받지 못한다** — 사용자에게는
// "한번씩 안 된다" 로 보이고, 그것이 §2.3 이 가르려던 바로 그 증상이다.
// WS 경로에는 이미 recover 가 있었고(handlers_ws.go:229·299) HTTP 에만 없었다.

// V-CAF-4 (FR-CAF-5): 패닉하는 핸들러가 500 을 낸다.
func TestRecoverMiddlewareTurnsPanicInto500(t *testing.T) {
	buf := captureLog(t)
	h := recoverMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/x", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("패닉한 핸들러가 %d 를 냈다 — 500 이어야 한다", rec.Code)
	}
	// 스택이 없으면 어디서 터졌는지 알 수 없다. 그물의 값어치가 거기 있다.
	if !strings.Contains(buf.String(), "boom") {
		t.Fatalf("패닉이 기록되지 않았다:\n%s", buf.String())
	}
}

// V-CAF-5 (FR-CAF-6): 이미 시작된 응답은 훼손하지 않는다.
//
// SSE(`/api/commands/sse`)와 WS 는 헤더를 먼저 보내고 오래 산다. 그 뒤의 패닉에
// `WriteHeader(500)` 을 부르면 상태가 뒤집히거나 `superfluous WriteHeader` 만
// 남는다 — 그물이 사고를 하나 더 만드는 셈이다.
func TestRecoverMiddlewareKeepsStartedResponse(t *testing.T) {
	captureLog(t)
	// 그물이 판정에 쓰는 바로 그 값(responseWriter.wrote)을 거쳐야 하므로 실제
	// 서버가 씌우는 것과 같은 래퍼를 준다. 상태를 **직접** 읽는 이유는 로그
	// 문자열 대조가 취약하기 때문이다 — 패닉 스택에 실린 주소(0x…500…)가 상태
	// 코드로 오인된다.
	rw := &responseWriter{ResponseWriter: httptest.NewRecorder(), status: http.StatusOK}
	h := recoverMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusMultiStatus)
		w.Write([]byte("part"))
		panic("late boom")
	}))

	h.ServeHTTP(rw, httptest.NewRequest(http.MethodGet, "/api/x", nil))

	if rw.status != http.StatusMultiStatus {
		t.Fatalf("그물이 이미 시작된 응답의 상태를 %d 로 덮었다 — 207 이어야 한다", rw.status)
	}
}

// V-CAF-6 (FR-CAF-7): `http.ErrAbortHandler` 는 삼키지 않는다.
//
// 그것은 패닉의 모양을 빌린 **약속된 값**이다 — `net/http` 에게 "조용히 끊어라"
// 를 뜻한다. 삼키면 500 본문이 나가고, 끊으려던 응답이 끊기지 않는다.
func TestRecoverMiddlewarePassesAbortHandler(t *testing.T) {
	h := recoverMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic(http.ErrAbortHandler)
	}))

	defer func() {
		if got := recover(); got != http.ErrAbortHandler {
			t.Fatalf("ErrAbortHandler 가 그대로 오르지 않았다: %v", got)
		}
	}()
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/x", nil))
	t.Fatal("ErrAbortHandler 를 그물이 삼켰다 — FR-CAF-7 위반")
}

// V-CAF-3 (FR-CAF-4): 디렉터리는 400 이다. `Stat` 의 결과를 실제로 본다는 뜻이며,
// 그 결과를 보려면 오류부터 봐야 한다 — 종전에는 `stat, _ :=` 로 받아 실패 시
// nil 을 역참조했다.
func TestFileReadRejectsDirectory(t *testing.T) {
	s := &Server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/file/read?path="+t.TempDir(), nil)

	s.apiFileRead(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("디렉터리에 %d 를 냈다 — 400 이어야 한다", rec.Code)
	}
}

// 정상 경로가 그대로인지 — 방어를 넣다 읽기를 막으면 안 된다.
func TestFileReadReturnsContent(t *testing.T) {
	p := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(p, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &Server{}
	rec := httptest.NewRecorder()

	s.apiFileRead(rec, httptest.NewRequest(http.MethodGet, "/api/file/read?path="+p, nil))

	if rec.Code != http.StatusOK || rec.Body.String() != "hello" {
		t.Fatalf("읽기가 깨졌다: code=%d body=%q", rec.Code, rec.Body.String())
	}
}
