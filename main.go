package main

import (
	"embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

//go:embed static/*
var staticFiles embed.FS

// ── Protocol ────────────────────────────────────────

const (
	opInput  byte = 0x00
	opResize byte = 0x01
	opOutput byte = 0x00
	opError  byte = 0x01
	opExit   byte = 0x02
	opSID    byte = 0x03
)

const (
	writeWait  = 10 * time.Second
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10
	bufMax     = 1 << 20
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

// ── OutputBuffer ────────────────────────────────────

type OutputBuffer struct {
	mu   sync.Mutex
	data []byte
	max  int
}

func newOutputBuffer(max int) *OutputBuffer { return &OutputBuffer{max: max} }

func (b *OutputBuffer) Write(p []byte) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.data = append(b.data, p...)
	if len(b.data) > b.max {
		b.data = b.data[len(b.data)-b.max:]
	}
}

func (b *OutputBuffer) Snapshot() []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]byte, len(b.data))
	copy(out, b.data)
	return out
}

// ── Pane (one PTY session) ──────────────────────────

type Pane struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	PID  int    `json:"pid"`
	ptmx *os.File
	cmd  *exec.Cmd
	buf  *OutputBuffer
	bch  chan []byte
	cmu  sync.Mutex
	cls  []*websocket.Conn
	done chan struct{}
	once sync.Once
}

func startPane(id, name string, cols, rows uint16) (*Pane, error) {
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
		"TERM=xterm-256color", "COLORTERM=truecolor",
		"LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8", "LC_CTYPE=en_US.UTF-8",
	)
	if home != "" {
		cmd.Dir = home
	}
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}
	p := &Pane{
		ID: id, Name: name,
		ptmx: ptmx, cmd: cmd,
		buf:  newOutputBuffer(bufMax),
		bch:  make(chan []byte, 256),
		done: make(chan struct{}),
	}
	go p.readPTY()
	go p.drainBuf()
	return p, nil
}

func (p *Pane) drainBuf() { for d := range p.bch { p.buf.Write(d) } }

func (p *Pane) readPTY() {
	raw := make([]byte, 8192)
	for {
		n, err := p.ptmx.Read(raw)
		if err != nil {
			if err != io.EOF {
				log.Printf("pane %s read: %v", p.ID, err)
			}
			p.broadcast([]byte{opExit})
			p.kill()
			pm.delete(p.ID)
			return
		}
		select {
		case p.bch <- append([]byte(nil), raw[:n]...):
		default:
		}
		msg := make([]byte, 1+n)
		msg[0] = opOutput
		copy(msg[1:], raw[:n])
		p.broadcast(msg)
	}
}

func (p *Pane) broadcast(msg []byte) {
	p.cmu.Lock()
	snap := make([]*websocket.Conn, len(p.cls))
	copy(snap, p.cls)
	p.cmu.Unlock()
	for _, c := range snap {
		c.SetWriteDeadline(time.Now().Add(writeWait))
		if err := c.WriteMessage(websocket.BinaryMessage, msg); err != nil {
			p.removeClient(c)
			c.Close()
		}
	}
}

func (p *Pane) addClient(c *websocket.Conn) {
	p.cmu.Lock()
	p.cls = append(p.cls, c)
	p.cmu.Unlock()
}

func (p *Pane) removeClient(c *websocket.Conn) {
	p.cmu.Lock()
	for i, v := range p.cls {
		if v == c {
			p.cls = append(p.cls[:i], p.cls[i+1:]...)
			break
		}
	}
	p.cmu.Unlock()
}

func (p *Pane) resize(c, r uint16) error {
	return pty.Setsize(p.ptmx, &pty.Winsize{Cols: c, Rows: r})
}

func (p *Pane) kill() {
	p.once.Do(func() {
		close(p.done)
		p.ptmx.Close()
		if p.cmd.Process != nil {
			p.cmd.Process.Signal(syscall.SIGTERM)
			time.Sleep(50 * time.Millisecond)
			p.cmd.Process.Kill()
			p.cmd.Wait()
		}
	})
}

// ── PaneManager ─────────────────────────────────────

type PaneManager struct {
	mu     sync.Mutex
	panes  map[string]*Pane
	nextID int
}

var pm = &PaneManager{panes: make(map[string]*Pane)}

func (m *PaneManager) create(cols, rows uint16) (*Pane, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	id := strconv.Itoa(m.nextID)
	name := fmt.Sprintf("Shell #%d", m.nextID)
	p, err := startPane(id, name, cols, rows)
	if err != nil {
		return nil, err
	}
	m.panes[id] = p
	log.Printf("pane created: %s pid=%d", id, p.cmd.Process.Pid)
	return p, nil
}

func (m *PaneManager) get(id string) *Pane {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.panes[id]
}

func (m *PaneManager) list() []map[string]interface{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []map[string]interface{}
	for _, p := range m.panes {
		pid := 0
		if p.cmd.Process != nil {
			pid = p.cmd.Process.Pid
		}
		out = append(out, map[string]interface{}{
			"id": p.ID, "name": p.Name, "pid": pid,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["id"].(string) < out[j]["id"].(string) })
	return out
}

func (m *PaneManager) delete(id string) {
	m.mu.Lock()
	p := m.panes[id]
	delete(m.panes, id)
	m.mu.Unlock()
	if p != nil {
		p.kill()
		log.Printf("pane killed: %s", id)
	}
}

// ── Workspace (frontend-managed, server-persisted) ──

type LayoutNode struct {
	Type      string        `json:"type"`
	PaneID    string        `json:"paneId,omitempty"`
	Direction string        `json:"direction,omitempty"`
	Children  []*LayoutNode `json:"children,omitempty"`
}

type Tab struct {
	ID       string      `json:"id"`
	Name     string      `json:"name"`
	ActiveID string      `json:"activeId"`
	Layout   *LayoutNode `json:"layout"`
}

type Session struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Tabs      []*Tab `json:"tabs"`
	ActiveTab string `json:"activeTab"`
}

type Workspace struct {
	Sessions      []*Session `json:"sessions"`
	ActiveSession string     `json:"activeSession"`
}

var (
	ws   = &Workspace{}
	wsMu sync.Mutex
)

func loadWorkspace() {
	data, err := os.ReadFile("workspace.json")
	if err != nil {
		return
	}
	json.Unmarshal(data, ws)
}

func saveWorkspace() {
	wsMu.Lock()
	data, _ := json.MarshalIndent(ws, "", "  ")
	wsMu.Unlock()
	os.WriteFile("workspace.json", data, 0644)
}

// ── API ─────────────────────────────────────────────

func handleAPI(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path

	switch {
	case p == "/api/state" && r.Method == http.MethodGet:
		wsMu.Lock()
		wsCopy := *ws
		wsMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"panes":     pm.list(),
			"workspace": wsCopy,
		})

	case p == "/api/panes" && r.Method == http.MethodPost:
		cols, rows := parseSize(r)
		pane, err := pm.create(cols, rows)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id": pane.ID, "name": pane.Name})

	case strings.HasPrefix(p, "/api/panes/") && r.Method == http.MethodDelete:
		id := strings.TrimPrefix(p, "/api/panes/")
		pm.delete(id)
		w.WriteHeader(200)

	case p == "/api/workspace" && r.Method == http.MethodPut:
		wsMu.Lock()
		json.NewDecoder(r.Body).Decode(ws)
		wsMu.Unlock()
		saveWorkspace()
		w.WriteHeader(200)

	default:
		http.Error(w, "not found", 404)
	}
}

// ── WebSocket ───────────────────────────────────────

func handleWS(w http.ResponseWriter, r *http.Request) {
	log.Printf("ws: new connection from %s pane=%s", r.RemoteAddr, r.URL.Query().Get("pane"))
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws: upgrade failed: %v", err)
		return
	}
	defer conn.Close()

	cols, rows := parseSize(r)
	paneID := r.URL.Query().Get("pane")

	var pane *Pane
	if paneID != "" {
		pane = pm.get(paneID)
		if pane == nil {
			wsSend(conn, opError, []byte("pane not found"))
			return
		}
	} else {
		pane, err = pm.create(cols, rows)
		if err != nil {
			wsSend(conn, opError, []byte("create failed: "+err.Error()))
			return
		}
	}

	// Send assigned pane ID
	// Add client BEFORE replaying buffer to avoid data gap
	conn.SetWriteDeadline(time.Now().Add(pingPeriod + writeWait))
	pane.addClient(conn)
	defer pane.removeClient(conn)

	wsSend(conn, opSID, []byte(pane.ID))

	// On reconnect: replay buffer + resize
	if paneID != "" {
		if snap := pane.buf.Snapshot(); len(snap) > 0 {
			msg := make([]byte, 1+len(snap))
			msg[0] = opOutput
			copy(msg[1:], snap)
			conn.SetWriteDeadline(time.Now().Add(writeWait))
			conn.WriteMessage(websocket.BinaryMessage, msg)
		}
		pane.resize(cols, rows)
	}

	go pingLoop(conn, pane.done)
	readWS(conn, pane)
}

func wsSend(conn *websocket.Conn, op byte, payload []byte) {
	m := make([]byte, 1+len(payload))
	m[0] = op
	copy(m[1:], payload)
	conn.SetWriteDeadline(time.Now().Add(writeWait))
	conn.WriteMessage(websocket.BinaryMessage, m)
}

func readWS(conn *websocket.Conn, pane *Pane) {
	conn.SetReadLimit(1 << 20)
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error { conn.SetReadDeadline(time.Now().Add(pongWait)); return nil })

	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if len(msg) == 0 {
			continue
		}
		switch msg[0] {
		case opInput:
			pane.ptmx.Write(msg[1:])
		case opResize:
			if len(msg) >= 5 {
				c := binary.BigEndian.Uint16(msg[1:3])
				ro := binary.BigEndian.Uint16(msg[3:5])
				pane.resize(c, ro)
			}
		}
	}
}

func pingLoop(conn *websocket.Conn, done chan struct{}) {
	t := time.NewTicker(pingPeriod)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			conn.SetWriteDeadline(time.Now().Add(pingPeriod + writeWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		case <-done:
			return
		}
	}
}

func parseSize(r *http.Request) (uint16, uint16) {
	c, ro := uint16(120), uint16(40)
	if v, err := strconv.ParseUint(r.URL.Query().Get("cols"), 10, 16); err == nil && v > 0 {
		c = uint16(v)
	}
	if v, err := strconv.ParseUint(r.URL.Query().Get("rows"), 10, 16); err == nil && v > 0 {
		ro = uint16(v)
	}
	return c, ro
}

// ── Main ────────────────────────────────────────────

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	loadWorkspace()

	staticFS, _ := fs.Sub(staticFiles, "static")
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(staticFS)))
	mux.HandleFunc("/ws", handleWS)
	mux.HandleFunc("/api/", handleAPI)

	server := &http.Server{Addr: ":" + port, Handler: mux}
	log.Printf("remote-terminal on :%s", port)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sigCh; saveWorkspace(); server.Close() }()

	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
}
