// 묶음 S — 브라우저 LSP 클라이언트와 언어 서버 프로세스의 통로다
// (CODEMIRROR_MIGRATION_SRS §3.11).
//
// **여기에도 LSP 가 없다.** 프레이밍·프로세스는 도메인 패키지의 `lsp.Tunnel` 이 맡고,
// 이 파일은 WebSocket 메시지와 통로 사이를 옮길 뿐이다 (D-4).
package httpapi

import (
	"errors"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/domain/lsp"
)

// close code (FR-CMR-102·103). 브라우저(`lsp-client.js`)가 같은 값을 쓴다.
const (
	lspWSCloseLimit = 4001 // 동시 실행 상한
	lspWSCloseStart = 4002 // 기동 실패 — reason 에 사유
	lspWSCloseEnded = 4003 // 프로세스 종료·유휴 정리
)

// lspWSReasonMax 는 close reason 의 상한이다 — control 프레임 본문 125바이트에서
// code 2바이트를 뺀 값이다 (RFC 6455 §5.5).
const lspWSReasonMax = 123

// lspWSReadLimit 은 브라우저 메시지 하나의 상한이다 (FR-CMR-104) — 텍스트 상한을
// JSON 문자열로 실은 최악의 크기다. 넘으면 gorilla 가 1009 로 닫는다. 터미널 WS 의
// 1MiB 는 쓰지 않는다 — didOpen 한 번이 파일 전체를 싣는다.
//
// var 인 것은 검사가 낮춰 쓰기 위해서다.
var lspWSReadLimit = lspAskMaxBody

// lspWSCloseWait 는 close 프레임을 쓰는 데 기다리는 시간이다.
const lspWSCloseWait = time.Second

// apiLSPWS 는 `GET /api/lsp/ws?root=<루트>&server=<서술자 id>` 다 (FR-CMR-91·100).
//
// 루트·서술자가 틀리면 업그레이드 전에 HTTP 로 답한다. 상한·기동 실패는 업그레이드
// 뒤 close code 로 알린다 — 브라우저의 WebSocket 은 HTTP 상태를 읽지 못한다.
func (s *Server) apiLSPWS(w http.ResponseWriter, r *http.Request) {
	if !s.lspReady(w) {
		return
	}
	q := r.URL.Query()
	desc := q.Get("server")
	if desc == "" {
		writeToolIOError(w, http.StatusBadRequest, "server required")
		return
	}
	root, ok := s.fsRoot(w, q.Get("root"))
	if !ok {
		return
	}
	conn, err := toolhub.Upgrader.Upgrade(w, r, nil)
	if err != nil {
		dmlog.Infof(nil, "lsp ws upgrade addr=%s: %v", r.RemoteAddr, err)
		return
	}
	defer conn.Close()
	conn.SetReadLimit(lspWSReadLimit)

	var wmu sync.Mutex
	closeWith := func(code int, reason string) {
		wmu.Lock()
		defer wmu.Unlock()
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(code, lspWSReason(reason)), time.Now().Add(lspWSCloseWait))
	}

	t, err := s.LSP.OpenTunnel(root, desc)
	if err != nil {
		if errors.Is(err, lsp.ErrLimit) {
			closeWith(lspWSCloseLimit, "limit")
			return
		}
		closeWith(lspWSCloseStart, err.Error())
		return
	}
	defer t.Close()

	// 서버 → 브라우저. 프로세스가 끝나면 close 를 보내고 연결을 끊어 읽기 쪽을 깨운다.
	go func() {
		for {
			b, err := t.Recv()
			if err != nil {
				closeWith(lspWSCloseEnded, "ended")
				_ = conn.Close()
				return
			}
			wmu.Lock()
			err = conn.WriteMessage(websocket.TextMessage, b)
			wmu.Unlock()
			if err != nil {
				return
			}
		}
	}()

	// 브라우저 → 서버. 연결이 닫히거나 상한을 넘으면 끝나고, defer 가 통로를 닫는다.
	for {
		mt, b, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if mt != websocket.TextMessage {
			continue
		}
		if err := t.Send(b); err != nil {
			return
		}
	}
}

// lspWSReason 은 reason 을 control 프레임 한도 안의 온전한 UTF-8 로 자른다.
func lspWSReason(s string) string {
	if len(s) <= lspWSReasonMax {
		return s
	}
	s = s[:lspWSReasonMax]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s
}
