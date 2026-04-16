package main

import (
	"embed"
	"encoding/binary"
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

// Protocol
//   Client → Server:
//     [0x00] + data                         → terminal input
//     [0x01] + cols(u16 BE) + rows(u16 BE)  → resize
//   Server → Client:
//     [0x00] + data                         → terminal output
//     [0x01] + message                      → error
//     [0x02]                                → process exited

const (
	opInput  byte = 0x00
	opResize byte = 0x01
	opOutput byte = 0x00
	opError  byte = 0x01
	opExit   byte = 0x02
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type session struct {
	ptmx      *os.File
	cmd       *exec.Cmd
	conn      *websocket.Conn
	writeMu   sync.Mutex
	closeOnce sync.Once
}

func handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade: %v", err)
		return
	}
	defer conn.Close()

	cols, rows := parseSize(r)

	// Determine shell
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
		log.Printf("pty start: %v", err)
		return
	}

	s := &session{ptmx: ptmx, cmd: cmd, conn: conn}
	defer s.close()

	log.Printf("connected: pid=%d shell=%s", cmd.Process.Pid, shell)

	// Set initial write deadline before readPTY starts writing
	conn.SetWriteDeadline(time.Now().Add(pingPeriod + writeWait))

	go s.readPTY()
	go s.pingLoop()
	s.wsToPTY()

	log.Printf("disconnected: pid=%d", cmd.Process.Pid)
}

func (s *session) close() {
	s.closeOnce.Do(func() {
		s.ptmx.Close()
		if s.cmd.Process != nil {
			s.cmd.Process.Signal(syscall.SIGTERM)
			time.Sleep(50 * time.Millisecond)
			s.cmd.Process.Kill()
			s.cmd.Wait()
		}
	})
}

func (s *session) readPTY() {
	buf := make([]byte, 8192)
	for {
		n, err := s.ptmx.Read(buf)
		if err != nil {
			if err != io.EOF {
				log.Printf("pty read: %v", err)
			}
			data := make([]byte, 1)
			data[0] = opExit
			s.writeMsg(data)
			return
		}
		msg := make([]byte, 1+n)
		msg[0] = opOutput
		copy(msg[1:], buf[:n])
		if s.writeMsg(msg) != nil {
			return
		}
	}
}

func (s *session) writeMsg(msg []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(writeWait))
	return s.conn.WriteMessage(websocket.BinaryMessage, msg)
}

func (s *session) wsToPTY() {
	s.conn.SetReadLimit(1 << 20)
	s.conn.SetReadDeadline(time.Now().Add(pongWait))
	s.conn.SetPongHandler(func(string) error {
		s.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, msg, err := s.conn.ReadMessage()
		if err != nil {
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
				pty.Setsize(s.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
			}
		}
	}
}

func (s *session) pingLoop() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for range ticker.C {
		s.writeMu.Lock()
		s.conn.SetWriteDeadline(time.Now().Add(pingPeriod + writeWait))
		err := s.conn.WriteMessage(websocket.PingMessage, nil)
		s.writeMu.Unlock()
		if err != nil {
			return
		}
	}
}

func parseSize(r *http.Request) (uint16, uint16) {
	cols, rows := uint16(120), uint16(40)
	if c, err := strconv.ParseUint(r.URL.Query().Get("cols"), 10, 16); err == nil && c > 0 {
		cols = uint16(c)
	}
	if ro, err := strconv.ParseUint(r.URL.Query().Get("rows"), 10, 16); err == nil && ro > 0 {
		rows = uint16(ro)
	}
	return cols, rows
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	staticFS, _ := fs.Sub(staticFiles, "static")

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(staticFS)))
	mux.HandleFunc("/ws", handleWS)

	server := &http.Server{Addr: ":" + port, Handler: mux}
	log.Printf("remote-terminal starting on http://localhost:%s", port)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sigCh; server.Close() }()

	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
}
