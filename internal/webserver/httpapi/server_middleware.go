package httpapi

import (
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/apierr"

	"bufio"
	"fmt"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `server.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **모든 요청이 지나는 겹**이다 — 패닉 회수·로깅·응답 래퍼. 서버가
// 무엇을 들고 있는지(`Server` 의 필드)와는 다른 층이며, 종단이 늘어도 이 겹은
// 늘지 않는다.

// --- HTTP recover middleware ------------------------------------------------

// recoverMiddleware 는 핸들러의 패닉을 500 으로 바꾸고 스택과 함께 남긴다
// (FR-CAF-5).
//
// **왜 필요한가.** `net/http` 는 패닉을 잡아 그 연결만 끊는다. 서버는 살아남지만
// 브라우저는 아무 응답도 받지 못하고, 남는 것은 스택뿐이다 — 사용자에게는
// "한번씩 안 된다" 로 보인다. WS 경로는 이미 recover 를 쓰고 있었고
// (handlers_ws.go:229·299) HTTP 경로에만 그물이 없었다.
//
// 두 가지를 하지 않는다:
//
//	① 이미 시작된 응답의 헤더를 건드리지 않는다 (FR-CAF-6). SSE·WS 가 그 처지다.
//	② `http.ErrAbortHandler` 를 삼키지 않는다 (FR-CAF-7). 그것은 패닉의 모양을
//	   빌린 약속된 값이며, 뜻은 "조용히 끊어라" 다.
func recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v)
			}
			dmlog.Errorf(nil, "http panic %s %s: %v\n%s", r.Method, r.URL.Path, v, debug.Stack())
			if rw, ok := w.(*responseWriter); ok && rw.wrote {
				return
			}
			httpErr(w, "internal error", http.StatusInternalServerError, apierr.CodeInternal)
		}()
		next.ServeHTTP(w, r)
	})
}

// --- HTTP logging middleware ------------------------------------------------

func loggingMiddleware(next http.Handler) http.Handler {
	return loggingMiddlewareFor(nil, next)
}

// loggingMiddlewareFor 는 로그와 함께 **마지막 요청 시각**을 새긴다
// (FR-CNR-11). srv 가 nil 이면 새기지 않는다 — 서버 없이 쓰는 테스트가 있다.
//
// 새기는 자리가 `shouldLogRequest` **바깥**인 것이 요점이다. 핫패스 필터로
// 로그에서 빠지는 `/api/ping` 도 "요청이 왔다" 는 사실은 같으며, 진단이 가르려는
// 것이 정확히 그 사실이다 (§2.3).
func loggingMiddlewareFor(srv *Server, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		if srv != nil {
			srv.lastReq.Store(start.UnixNano())
		}
		rw := &responseWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(rw, r)
		if shouldLogRequest(r.URL.Path, rw.status) {
			// FR-OBS-9: 접근 로그가 요청 ID 를 싣는다 — 이 줄과 핸들러가 남긴
			// 줄과 데몬 RPC 줄이 같은 값으로 묶인다.
			dmlog.Infof(r.Context(), "http %s %s %d %s addr=%s",
				r.Method, r.URL.Path, rw.status, time.Since(start).Round(time.Millisecond), r.RemoteAddr)
		}
	})
}

// shouldLogRequest filters high-frequency hot-path endpoints from the access
// log. Errors (status>=400) always log so failures stay observable. Split
// tools / tool-delete flows hammer /api/workspace and /api/tools dozens of
// times per second; logging each one caused hundreds of ms of keyboard-input
// lag (H5).
func shouldLogRequest(path string, status int) bool {
	if status >= 400 {
		return true
	}
	switch path {
	case "/api/ping", "/api/stats":
		return false
	}
	if strings.HasPrefix(path, "/api/workspace") || strings.HasPrefix(path, "/api/tools") {
		return false
	}
	return true
}

type responseWriter struct {
	http.ResponseWriter
	status int
	// wrote 는 **응답이 이미 시작됐는가** 다. 그물(recoverMiddleware)이 이것을
	// 읽는다 — 헤더가 나간 뒤의 패닉에 500 을 덧쓰면 상태가 뒤집히거나
	// `superfluous WriteHeader` 만 남는다 (FR-CAF-6). SSE 와 하이재킹된 WS 가
	// 정확히 그 처지다.
	wrote bool
}

func (rw *responseWriter) WriteHeader(status int) {
	if rw.wrote {
		return
	}
	rw.wrote = true
	rw.status = status
	rw.ResponseWriter.WriteHeader(status)
}

// Write 는 헤더를 명시적으로 쓰지 않고 본문부터 내보내는 핸들러를 위한 것이다 —
// 그 경우에도 응답은 시작된 것이며(net/http 가 200 을 먼저 보낸다), 그물은 그
// 사실을 알아야 한다.
func (rw *responseWriter) Write(b []byte) (int, error) {
	rw.wrote = true
	return rw.ResponseWriter.Write(b)
}

func (rw *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := rw.ResponseWriter.(http.Hijacker); ok {
		// 하이재킹된 뒤로 이 ResponseWriter 는 쓸 수 없다. 그물이 여기에
		// 헤더를 쓰면 패닉이 하나 더 난다.
		rw.wrote = true
		return h.Hijack()
	}
	return nil, nil, fmt.Errorf("ResponseWriter does not implement http.Hijacker")
}

func (rw *responseWriter) Flush() {
	if f, ok := rw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// assetVersion 은 지금 서빙하는 자산의 판을 준다. 모르면 빈 문자열이다.
//
// ASSET_VERSION_SINGLE_SOURCE_SRS FR-AVS-3: 판을 아는 자리는 **하나**다. 문서에 넣는
// 값과 인사에 싣는 값이 여기서 함께 나온다.
//
// 종전에는 서빙되는 `index.html` 을 되읽어 `?v=` 를 정규식으로 긁었다. 그때는 문서가
// 판을 손으로 적었고, 손으로 적은 상수와 갈라지는 것을 막을 길이 그것뿐이었다
// (RELOAD_CONTINUITY_SRS FR-RLC-21). 이제 문서를 **쓰는 쪽**이 여기이므로 갈릴 수가
// 없다 — 되읽는 것은 같은 값을 두 번 만드는 일이며, 깨질 정규식을 하나 더 두는 것이다.
