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
			conn.send(OpError, []byte("pane not found"))
			log.Printf("ws addr=%s: pane %s not found", r.RemoteAddr, paneID)
			return
		}
	} else {
		pane, err = s.Panes.Create("", cols, rows)
		if err != nil {
			conn.send(OpError, []byte("create failed"))
			log.Printf("ws addr=%s: pane create error: %v", r.RemoteAddr, err)
			return
		}
	}

	pane.addClient(conn)
	defer pane.removeClient(conn)

	conn.send(OpSID, []byte(pane.ID))

	if paneID != "" {
		if snap, _ := pane.stream.Snapshot(); len(snap) > 0 {
			msg := make([]byte, 1+len(snap))
			msg[0] = OpOutput
			copy(msg[1:], snap)
			if err := conn.writeMsg(websocket.BinaryMessage, msg); err != nil {
				log.Printf("[pane %s] snapshot send error addr=%s: %v", pane.ID, r.RemoteAddr, err)
				return
			}
		}
		if pane.restored {
			pane.restored = false
			reset := []byte("\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?2004l\x1b[?1049l\x1b[?47l\x1b[?1047l\x1b[?25h\x1b[?12l\x1b[20l")
			msg := make([]byte, 1+len(reset))
			msg[0] = OpOutput
			copy(msg[1:], reset)
			if err := conn.writeMsg(websocket.BinaryMessage, msg); err != nil {
				log.Printf("[pane %s] reset send error addr=%s: %v", pane.ID, r.RemoteAddr, err)
				return
			}
		}
		pane.resize(cols, rows)
	}

	go pingLoop(conn, pane.done)
	readWS(conn, pane)
	log.Printf("ws disconnected addr=%s pane=%s", r.RemoteAddr, pane.ID)
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
