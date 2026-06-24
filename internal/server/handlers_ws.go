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
	if s.Panes == nil {
		http.Error(w, "panes unavailable", http.StatusInternalServerError)
		return
	}
	raw, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade addr=%s: %v", r.RemoteAddr, err)
		return
	}
	conn := newSafeConn(raw)
	defer conn.close()

	paneID := r.URL.Query().Get("pane")
	log.Printf("ws connected addr=%s pane=%s", r.RemoteAddr, paneID)

	cols, rows := ParseSize(r)
	var pane *Pane

	if paneID != "" {
		pane = s.Panes.Get(paneID)
		if pane == nil {
			// During a daemon reconnect window Get() fails transiently. Don't
			// declare the pane gone — just close so the browser shows "재연결 중"
			// and keeps retrying; OpExit is reserved for a genuinely absent pane.
			if dc, ok := s.Panes.(interface{ Connected() bool }); ok && !dc.Connected() {
				log.Printf("ws addr=%s: pane %s lookup during daemon reconnect; closing for retry", r.RemoteAddr, paneID)
				return
			}
			// Send OpExit so the frontend knows this pane is permanently gone.
			conn.send(OpExit, nil)
			conn.close()
			log.Printf("ws addr=%s: pane %s not found (sent OpExit)", r.RemoteAddr, paneID)
			return
		}
	} else {
		pane, err = s.Panes.Create("", cols, rows)
		if err != nil {
			conn.send(OpError, []byte("create failed"))
			log.Printf("ws addr=%s: pane create error: %v", r.RemoteAddr, err)
			return
		}
		paneID = pane.ID
	}

	// Branch: daemon mode vs direct mode
	if s.Panes.IsDaemon() {
		s.handleWSDaemon(conn, paneID, pane, cols, rows)
	} else {
		s.handleWSDirect(conn, pane, cols, rows, r.RemoteAddr)
	}
}

// handleWSDirect is the original (non-daemon) WebSocket handler.
func (s *Server) handleWSDirect(conn *safeConn, pane *Pane, cols, rows uint16, remoteAddr string) {
	if !pane.addClient(conn) {
		log.Printf("ws addr=%s: pane %s already exited; sent OpExit", remoteAddr, pane.ID)
		return
	}
	defer pane.removeClient(conn)

	conn.send(OpSID, []byte(pane.ID))

	// Send scrollback snapshot for existing pane
	if snap, _ := pane.stream.Snapshot(); len(snap) > 0 {
		snap = stripOSC777(snap)
		if len(snap) > 0 {
			msg := make([]byte, 1+len(snap))
			msg[0] = OpOutput
			copy(msg[1:], snap)
			if err := conn.writeMsg(websocket.BinaryMessage, msg); err != nil {
				log.Printf("[pane %s] snapshot send error addr=%s: %v", pane.ID, remoteAddr, err)
				return
			}
		}
	}
	if pane.restored {
		pane.restored = false
		reset := []byte("\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1049l\x1b[?47l\x1b[?1047l\x1b[?25h\x1b[?12l\x1b[20l")
		msg := make([]byte, 1+len(reset))
		msg[0] = OpOutput
		copy(msg[1:], reset)
		if err := conn.writeMsg(websocket.BinaryMessage, msg); err != nil {
			log.Printf("[pane %s] reset send error addr=%s: %v", pane.ID, remoteAddr, err)
			return
		}
	}
	pane.resize(cols, rows)

	done := make(chan struct{})
	go pingLoop(conn, pane.done)
	readWSDirect(conn, pane)
	log.Printf("ws disconnected addr=%s pane=%s", remoteAddr, pane.ID)
	_ = done
}

// handleWSDaemon is the daemon-mode WebSocket handler.
// It uses PaneHub methods (which go through PaneClient RPC) instead of
// Pane struct internals.
func (s *Server) handleWSDaemon(conn *safeConn, paneID string, _ *Pane, cols, rows uint16) {
	_ = s.Panes.Resize(paneID, cols, rows)

	conn.send(OpSID, []byte(paneID))

	// Send terminal reset to clear any stale modes (mouse tracking, etc.)
	// from a previous connection.
	reset := []byte("\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1049l\x1b[?47l\x1b[?1047l\x1b[?25h\x1b[?12l\x1b[20l")
	if err := conn.writeMsg(websocket.BinaryMessage, append([]byte{OpOutput}, reset...)); err != nil {
		return
	}

	pc, ok := s.Panes.(*PaneClient)
	if !ok {
		log.Printf("[pane %s] daemon mode but PaneHub is not *PaneClient", paneID)
		return
	}

	// Subscribe to live output BEFORE taking the snapshot so output produced
	// during the snapshot RPC round-trip is buffered rather than lost (FR-17).
	// The small overlap between the snapshot and the buffered live stream may
	// duplicate a few bytes, which xterm.js redraws harmlessly — preferable to
	// a gap that could desync escape-sequence parsing.
	outputCh := make(chan []byte, 256)
	exitCh, unsub := pc.Subscribe(paneID, outputCh)
	defer unsub()

	// Send snapshot for reconnection.
	if snap, err := s.Panes.SnapshotPane(paneID); err == nil && len(snap.Data) > 0 {
		log.Printf("[ws-daemon] snapshot pane=%s len=%d retained=%d", paneID, len(snap.Data), snap.Retained)
		snapData := stripOSC777(snap.Data)
		if len(snapData) > 0 {
			msg := make([]byte, 1+len(snapData))
			msg[0] = OpOutput
			copy(msg[1:], snapData)
			if err := conn.writeMsg(websocket.BinaryMessage, msg); err != nil {
				log.Printf("[pane %s] snapshot send error: %v", paneID, err)
				return
			}
		}
	}

	done := make(chan struct{})
	defer close(done)

	// Output relay goroutine. Attention/activity detection happens once in the
	// PaneClient readLoop (OnOutput), not here, so it is not tied to this WS
	// subscription. On pane exit (exitCh closed) we send OpExit and close the
	// socket so the browser tears the terminal down (parity with direct mode).
	go func() {
		for {
			select {
			case data := <-outputCh:
				conn.send(OpOutput, data)
			case <-exitCh:
				conn.send(OpExit, nil)
				conn.close()
				return
			case <-done:
				return
			}
		}
	}()

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
				log.Printf("[pane %s] readWS error: %v", paneID, err)
			}
			return
		}
		if len(msg) == 0 {
			continue
		}
		switch msg[0] {
		case OpInput:
			_ = pc.Write(paneID, msg[1:])
		case OpResize:
			if len(msg) >= 5 {
				c := binary.BigEndian.Uint16(msg[1:3])
				ro := binary.BigEndian.Uint16(msg[3:5])
				_ = pc.Resize(paneID, c, ro)
			}
		}
	}
}

func readWS(conn *safeConn, pane *Pane) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[pane %s] readWS panic addr=%s: %v\n%s", pane.ID, conn.remoteAddr(), r, debug.Stack())
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
				log.Printf("[pane %s] readWS error addr=%s: %v", pane.ID, conn.remoteAddr(), err)
			}
			return
		}
		if len(msg) == 0 {
			continue
		}
		switch msg[0] {
		case OpInput:
			if _, err := pane.ptmx.Write(msg[1:]); err != nil {
				log.Printf("[pane %s] ptmx write error: %v", pane.ID, err)
				return
			}
		case OpResize:
			if len(msg) >= 5 {
				c := binary.BigEndian.Uint16(msg[1:3])
				ro := binary.BigEndian.Uint16(msg[3:5])
				pane.resize(c, ro)
			}
		}
	}
}

// readWSDirect is the original WS read loop kept for direct mode.
func readWSDirect(conn *safeConn, pane *Pane) { readWS(conn, pane) }

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

func (s *Server) handleCSProxy(w http.ResponseWriter, r *http.Request) {
	if s.CS == nil {
		http.Error(w, "code-server unavailable", http.StatusInternalServerError)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/cs/")
	idx := strings.Index(rest, "/")
	id := rest
	if idx >= 0 {
		id = rest[:idx]
	}
	if id == "" {
		http.NotFound(w, r)
		return
	}
	inst := s.CS.Get(id)
	if inst == nil {
		http.Error(w, "code-server session not found", http.StatusNotFound)
		return
	}
	s.CS.Touch(id)
	if r.URL.Path == "/cs/"+id {
		http.Redirect(w, r, "/cs/"+id+"/", http.StatusMovedPermanently)
		return
	}
	inst.Proxy.ServeHTTP(w, r)
}
