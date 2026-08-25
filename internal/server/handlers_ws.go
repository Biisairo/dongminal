package server

import (
	"encoding/binary"
	"log"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if s.Tools == nil {
		http.Error(w, "tools unavailable", http.StatusInternalServerError)
		return
	}
	raw, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade addr=%s: %v", r.RemoteAddr, err)
		return
	}
	conn := newSafeConn(raw)
	defer conn.close()

	toolID := r.URL.Query().Get("tool")
	log.Printf("ws connected addr=%s tool=%s", r.RemoteAddr, toolID)

	cols, rows := ParseSize(r)
	var tool *Tool

	if toolID != "" {
		tool = s.Tools.Get(toolID)
		if tool == nil {
			// During a daemon reconnect window Get() fails transiently. Don't
			// declare the tool gone — just close so the browser shows "재연결 중"
			// and keeps retrying; OpExit is reserved for a genuinely absent tool.
			if dc, ok := s.Tools.(interface{ Connected() bool }); ok && !dc.Connected() {
				log.Printf("ws addr=%s: tool %s lookup during daemon reconnect; closing for retry", r.RemoteAddr, toolID)
				return
			}
			// Send OpExit so the frontend knows this tool is permanently gone.
			_ = conn.send(OpExit, nil)
			conn.close()
			log.Printf("ws addr=%s: tool %s not found (sent OpExit)", r.RemoteAddr, toolID)
			return
		}
	} else {
		tool, err = s.Tools.Create("", cols, rows)
		if err != nil {
			_ = conn.send(OpError, []byte("create failed"))
			log.Printf("ws addr=%s: tool create error: %v", r.RemoteAddr, err)
			return
		}
		toolID = tool.ID
	}

	// Branch: daemon mode vs direct mode
	if s.Tools.IsDaemon() {
		s.handleWSDaemon(conn, toolID, tool, cols, rows)
	} else {
		s.handleWSDirect(conn, tool, cols, rows, r.RemoteAddr)
	}
}

// handleWSDirect is the original (non-daemon) WebSocket handler.
func (s *Server) handleWSDirect(conn *safeConn, tool *Tool, cols, rows uint16, remoteAddr string) {
	if !tool.addClient(conn) {
		log.Printf("ws addr=%s: tool %s already exited; sent OpExit", remoteAddr, tool.ID)
		return
	}
	defer tool.removeClient(conn)

	_ = conn.send(OpToolID, []byte(tool.ID))

	// Send scrollback snapshot for existing tool
	if snap, _ := tool.stream.Snapshot(); len(snap) > 0 {
		snap = stripSnapshotQueries(stripOSC777(snap))
		if len(snap) > 0 {
			msg := make([]byte, 1+len(snap))
			msg[0] = OpOutput
			copy(msg[1:], snap)
			if err := conn.writeMsg(websocket.BinaryMessage, msg); err != nil {
				log.Printf("[tool %s] snapshot send error addr=%s: %v", tool.ID, remoteAddr, err)
				return
			}
		}
	}
	if tool.restored {
		tool.restored = false
		reset := []byte("\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1049l\x1b[?47l\x1b[?1047l\x1b[?25h\x1b[?12l\x1b[20l")
		msg := make([]byte, 1+len(reset))
		msg[0] = OpOutput
		copy(msg[1:], reset)
		if err := conn.writeMsg(websocket.BinaryMessage, msg); err != nil {
			log.Printf("[tool %s] reset send error addr=%s: %v", tool.ID, remoteAddr, err)
			return
		}
	}

	done := make(chan struct{})
	go pingLoop(conn, tool.done)
	readWSDirect(conn, tool)
	log.Printf("ws disconnected addr=%s tool=%s", remoteAddr, tool.ID)
	_ = done
}

// handleWSDaemon is the daemon-mode WebSocket handler.
// It uses ToolHub methods (which go through ToolClient RPC) instead of
// Tool struct internals.
// Note: we do NOT resize the PTY from the URL query params here. When a
// new window opens, the frontend creates WS connections for ALL tools with
// default cols/rows (120x40), which would incorrectly resize tools owned by
// other windows. The frontend sends the correct OpResize via the WS binary
// protocol after terminal open+fit, guarded by _resizeCheck (session ownership).
func (s *Server) handleWSDaemon(conn *safeConn, toolID string, _ *Tool, cols, rows uint16) {
	_ = conn.send(OpToolID, []byte(toolID))

	// Send terminal reset to clear any stale modes (mouse tracking, etc.)
	// from a previous connection.
	reset := []byte("\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1049l\x1b[?47l\x1b[?1047l\x1b[?25h\x1b[?12l\x1b[20l")
	if err := conn.writeMsg(websocket.BinaryMessage, append([]byte{OpOutput}, reset...)); err != nil {
		return
	}

	pc, ok := s.Tools.(*ToolClient)
	if !ok {
		log.Printf("[tool %s] daemon mode but ToolHub is not *ToolClient", toolID)
		return
	}

	// Subscribe to live output BEFORE taking the snapshot so output produced
	// during the snapshot RPC round-trip is buffered rather than lost (FR-17).
	// The small overlap between the snapshot and the buffered live stream may
	// duplicate a few bytes, which xterm.js redraws harmlessly — preferable to
	// a gap that could desync escape-sequence parsing.
	outputCh := make(chan []byte, 256)
	exitCh, unsub := pc.Subscribe(toolID, outputCh)
	defer unsub()

	// Send snapshot for reconnection.
	if snap, err := s.Tools.SnapshotTool(toolID); err == nil && len(snap.Data) > 0 {
		log.Printf("[ws-daemon] snapshot tool=%s len=%d retained=%d", toolID, len(snap.Data), snap.Retained)
		snapData := stripSnapshotQueries(stripOSC777(snap.Data))
		if len(snapData) > 0 {
			msg := make([]byte, 1+len(snapData))
			msg[0] = OpOutput
			copy(msg[1:], snapData)
			if err := conn.writeMsg(websocket.BinaryMessage, msg); err != nil {
				log.Printf("[tool %s] snapshot send error: %v", toolID, err)
				return
			}
		}
	}

	done := make(chan struct{})
	defer close(done)

	// Output relay goroutine. Attention/activity detection happens once in the
	// ToolClient readLoop (OnOutput), not here, so it is not tied to this WS
	// subscription. On tool exit (exitCh closed) we send OpExit and close the
	// socket so the browser tears the terminal down (parity with direct mode).
	go relayOutput(conn, toolID, outputCh, exitCh, done)

	go pingLoop(conn, done)

	// Read loop: input → dongminald, resize → dongminald
	conn.setReadLimit(1 << 20)
	conn.setReadDeadline(time.Now().Add(pongWait))
	conn.setPongHandler(func(string) error {
		conn.setReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		_, msg, err := conn.readMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway, websocket.CloseNoStatusReceived) &&
				!strings.Contains(err.Error(), "use of closed network connection") {
				log.Printf("[tool %s] readWS error: %v", toolID, err)
			}
			return
		}
		if len(msg) == 0 {
			continue
		}
		switch msg[0] {
		case OpInput:
			_ = pc.Write(toolID, msg[1:])
		case OpResize:
			if len(msg) >= 5 {
				c := binary.BigEndian.Uint16(msg[1:3])
				ro := binary.BigEndian.Uint16(msg[3:5])
				_ = pc.Resize(toolID, c, ro)
			}
		}
	}
}

func readWS(conn *safeConn, tool *Tool) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[tool %s] readWS panic addr=%s: %v\n%s", tool.ID, conn.remoteAddr(), r, debug.Stack())
		}
	}()
	conn.setReadLimit(1 << 20)
	conn.setReadDeadline(time.Now().Add(pongWait))
	conn.setPongHandler(func(string) error {
		conn.setReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		_, msg, err := conn.readMessage()
		if err != nil {
			if !websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway, websocket.CloseNoStatusReceived) &&
				!strings.Contains(err.Error(), "use of closed network connection") {
				log.Printf("[tool %s] readWS error addr=%s: %v", tool.ID, conn.remoteAddr(), err)
			}
			return
		}
		if len(msg) == 0 {
			continue
		}
		switch msg[0] {
		case OpInput:
			if _, err := tool.ptmx.Write(msg[1:]); err != nil {
				log.Printf("[tool %s] ptmx write error: %v", tool.ID, err)
				return
			}
		case OpResize:
			if len(msg) >= 5 {
				c := binary.BigEndian.Uint16(msg[1:3])
				ro := binary.BigEndian.Uint16(msg[3:5])
				tool.resize(c, ro)
			}
		}
	}
}

// readWSDirect is the original WS read loop kept for direct mode.
func readWSDirect(conn *safeConn, tool *Tool) { readWS(conn, tool) }

// relayOutput pumps live tool output to one WS client until the tool exits,
// the handler returns, or **a write fails**.
//
// 쓰기 실패는 그 구독의 끝이다. 예전에는 실패를 로그만 남기고 계속 펌프했는데,
// 브라우저가 사라진 소켓(서버 재기동 직후의 옛 연결)에 초당 수십 회를 재시도하며
// broken pipe 를 쏟아냈다 — 읽기 루프가 pongWait 로 깨질 때까지 26초간 로그가
// 7.7MB 로 불었다 (실측 2026-08-25). 소켓을 닫으면 읽기 루프가 곧바로 풀리고
// 핸들러의 defer 가 구독을 해제한다.
func relayOutput(conn *safeConn, toolID string, outputCh <-chan []byte, exitCh <-chan struct{}, done <-chan struct{}) {
	for {
		select {
		case data := <-outputCh:
			if err := conn.send(OpOutput, data); err != nil {
				log.Printf("[tool %s] output relay stopped addr=%s: %v", toolID, conn.remoteAddr(), err)
				conn.close()
				return
			}
		case <-exitCh:
			_ = conn.send(OpExit, nil)
			conn.close()
			return
		case <-done:
			return
		}
	}
}

func pingLoop(conn *safeConn, done chan struct{}) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("pingLoop panic addr=%s: %v\n%s", conn.remoteAddr(), r, debug.Stack())
		}
	}()
	t := time.NewTicker(pingPeriod)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if err := conn.writePing(); err != nil {
				log.Printf("pingLoop error addr=%s: %v", conn.remoteAddr(), err)
				return
			}
		case <-done:
			return
		}
	}
}
