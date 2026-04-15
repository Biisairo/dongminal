package main

import (
	"embed"
	"encoding/binary"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

//go:embed static/*
var staticFiles embed.FS

// --- Binary Protocol ---
// Client → Server:
//   [0x00] + data          → terminal input (UTF-8)
//   [0x01] + col(u16) + row(u16) → resize
//
// Server → Client:
//   [0x00] + data          → terminal output (raw)
//   [0x01] + message       → error (UTF-8 string)
//   [0x02]                 → process exited
const (
	opInput  byte = 0x00
	opResize byte = 0x01
	opOutput byte = 0x00
	opError  byte = 0x01
	opExit   byte = 0x02
)

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 1 << 20 // 1MB
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// ptySession bridges a single PTY ↔ WebSocket connection.
type ptySession struct {
	ptmx     *os.File
	cmd      *exec.Cmd
	conn     *websocket.Conn
	writeMu  sync.Mutex
	closeOnce sync.Once
	done     chan struct{}
}

func newPTYSession(conn *websocket.Conn, cols, rows uint16) (*ptySession, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}
	if _, err := os.Stat(shell); os.IsNotExist(err) {
		shell = "/bin/sh"
	}

	home, _ := os.UserHomeDir()

	cmd := exec.Command(shell, "-l")
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"LANG=en_US.UTF-8",
		"LC_ALL=en_US.UTF-8",
		"LC_CTYPE=en_US.UTF-8",
	)
	if home != "" {
		cmd.Dir = home
	}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, fmt.Errorf("pty start: %w", err)
	}

	log.Printf("session started: pid=%d shell=%s size=%dx%d", cmd.Process.Pid, shell, cols, rows)

	return &ptySession{
		ptmx: ptmx,
		cmd:  cmd,
		conn: conn,
		done: make(chan struct{}),
	}, nil
}

// Close cleans up PTY and process. Safe to call multiple times.
func (s *ptySession) Close() {
	s.closeOnce.Do(func() {
		close(s.done)
		s.ptmx.Close()
		if s.cmd.Process != nil {
			s.cmd.Process.Signal(syscall.SIGTERM)
			time.Sleep(50 * time.Millisecond)
			s.cmd.Process.Kill()
			s.cmd.Wait()
		}
	})
}

func (s *ptySession) Resize(cols, rows uint16) error {
	return pty.Setsize(s.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

// sendWS sends a binary message with write mutex protection.
func (s *ptySession) sendWS(msg []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(writeWait))
	return s.conn.WriteMessage(websocket.BinaryMessage, msg)
}

// ptyToWS reads PTY output and sends to WebSocket.
func (s *ptySession) ptyToWS() {
	buf := make([]byte, 8192)
	for {
		n, err := s.ptmx.Read(buf)
		if err != nil {
			if err != io.EOF {
				log.Printf("pty read: %v", err)
			}
			s.sendWS([]byte{opExit})
			return
		}

		msg := make([]byte, 1+n)
		msg[0] = opOutput
		copy(msg[1:], buf[:n])
		if err := s.sendWS(msg); err != nil {
			return
		}
	}
}

// wsToPTY reads WebSocket messages and writes to PTY.
func (s *ptySession) wsToPTY() {
	s.conn.SetReadLimit(maxMessageSize)
	s.conn.SetReadDeadline(time.Now().Add(pongWait))
	s.conn.SetPongHandler(func(string) error {
		s.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, msg, err := s.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("ws read: %v", err)
			}
			return
		}
		if len(msg) == 0 {
			continue
		}

		switch msg[0] {
		case opInput:
			s.ptmx.Write(msg[1:])
		case opResize:
			if len(msg) >= 5 {
				cols := binary.BigEndian.Uint16(msg[1:3])
				rows := binary.BigEndian.Uint16(msg[3:5])
				if err := s.Resize(cols, rows); err != nil {
					log.Printf("resize error: %v", err)
				}
			}
		}
	}
}


func (s *ptySession) pingLoop() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			s.writeMu.Lock()
			s.conn.SetWriteDeadline(time.Now().Add(writeWait))
			err := s.conn.WriteMessage(websocket.PingMessage, nil)
			s.writeMu.Unlock()
			if err != nil {
				return
			}
		case <-s.done:
			return
		}
	}
}

// handleTerminal is the WebSocket endpoint for terminal sessions.
func handleTerminal(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}
	defer conn.Close()

	// Parse initial terminal size from query params
	cols := uint16(120)
	rows := uint16(40)
	if c, err := strconv.ParseUint(r.URL.Query().Get("cols"), 10, 16); err == nil && c > 0 {
		cols = uint16(c)
	}
	if ro, err := strconv.ParseUint(r.URL.Query().Get("rows"), 10, 16); err == nil && ro > 0 {
		rows = uint16(ro)
	}

	sess, err := newPTYSession(conn, cols, rows)
	if err != nil {
		log.Printf("session create: %v", err)
		errMsg := []byte{opError}
		errMsg = append(errMsg, []byte("Failed to start terminal: "+err.Error())...)
		conn.WriteMessage(websocket.BinaryMessage, errMsg)
		return
	}
	defer sess.Close()

	go sess.ptyToWS()
	go sess.pingLoop()
	sess.wsToPTY() // blocks until disconnect

	log.Printf("session ended: pid=%d", sess.cmd.Process.Pid)
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	// Serve static files (strip "static" prefix so / maps to static/index.html)
	staticFS, _ := fs.Sub(staticFiles, "static")
	fileServer := http.FileServer(http.FS(staticFS))

	mux := http.NewServeMux()
	mux.Handle("/", fileServer)
	mux.HandleFunc("/ws", handleTerminal)

	server := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
	}

	log.Printf("remote-terminal starting on http://localhost:%s", port)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Println("shutting down...")
		server.Close()
	}()

	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
}
