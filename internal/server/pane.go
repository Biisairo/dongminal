package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"dongminal/internal/outbuf"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

const (
	OpInput  byte = 0x00
	OpResize byte = 0x01
	OpOutput byte = 0x00
	OpError  byte = 0x01
	OpExit   byte = 0x02
	OpSID    byte = 0x03
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

// ── safeConn ─────────────────────────────────────────

type safeConn struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func newSafeConn(c *websocket.Conn) *safeConn { return &safeConn{conn: c} }

func (s *safeConn) writeMsg(typ int, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(writeWait))
	return s.conn.WriteMessage(typ, data)
}

func (s *safeConn) writePing() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(pingPeriod + writeWait))
	return s.conn.WriteMessage(websocket.PingMessage, nil)
}

func (s *safeConn) send(op byte, payload []byte) {
	m := make([]byte, 1+len(payload))
	m[0] = op
	copy(m[1:], payload)
	if err := s.writeMsg(websocket.BinaryMessage, m); err != nil {
		log.Printf("ws send op=0x%02x addr=%s: %v", op, s.remoteAddr(), err)
	}
}

func (s *safeConn) close()                              { s.conn.Close() }
func (s *safeConn) remoteAddr() string                  { return s.conn.RemoteAddr().String() }
func (s *safeConn) setReadLimit(l int64)                { s.conn.SetReadLimit(l) }
func (s *safeConn) setReadDeadline(t time.Time) error   { return s.conn.SetReadDeadline(t) }
func (s *safeConn) setPongHandler(h func(string) error) { s.conn.SetPongHandler(h) }
func (s *safeConn) readMessage() (int, []byte, error)   { return s.conn.ReadMessage() }

// ── Pane ────────────────────────────────────────────

type Pane struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	PID  int    `json:"pid"`
	ptmx *os.File
	cmd  *exec.Cmd
	stream *outbuf.Stream
	bch  chan []byte
	cmu  sync.Mutex
	cls  []*safeConn
	done chan struct{}
	once sync.Once
	onExit func(id string)
	restored bool
}

func (p *Pane) IsBusy() bool {
	if p.cmd == nil || p.cmd.Process == nil {
		return false
	}
	out, err := exec.Command("pgrep", "-P", strconv.Itoa(p.cmd.Process.Pid)).Output()
	if err != nil {
		return false
	}
	return len(strings.TrimSpace(string(out))) > 0
}

func (p *Pane) Cwd() string {
	if p.cmd != nil && p.cmd.Process != nil {
		cwd, _ := os.Readlink(fmt.Sprintf("/proc/%d/cwd", p.cmd.Process.Pid))
		if cwd != "" {
			return cwd
		}
		out, _ := exec.Command("lsof", "-p", fmt.Sprintf("%d", p.cmd.Process.Pid), "-Fn").Output()
		for _, l := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(l, "n") && !strings.Contains(l, "txt") {
				return strings.TrimPrefix(l, "n")
			}
		}
	}
	cwd, _ := os.Getwd()
	return cwd
}

// StartPane spawns a shell under a new PTY. Exported for pane manager + tests.
func StartPane(id, name, cwd string, cols, rows uint16, onExit func(string)) (*Pane, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}
	if _, err := os.Stat(shell); os.IsNotExist(err) {
		shell = "/bin/sh"
	}
	home, _ := os.UserHomeDir()
	cmd := exec.Command(shell, "-l")
	binDir := filepath.Join(os.Getenv("DONGMINAL_HOME"), "bin")
	env := []string{
		"TERM=xterm-256color", "COLORTERM=truecolor",
		"LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8", "LC_CTYPE=en_US.UTF-8",
		"PATH=" + os.Getenv("PATH") + ":" + binDir,
	}
	if strings.Contains(shell, "zsh") {
		zdotdir := filepath.Join(binDir, "zdotdir")
		env = append(env, "ZDOTDIR="+zdotdir)
	} else if strings.Contains(shell, "bash") {
		env = append(env, "BASH_ENV="+filepath.Join(binDir, "bash-hook.sh"))
	}
	cmd.Env = append(os.Environ(), env...)
	startDir := home
	if cwd != "" {
		if info, err := os.Stat(cwd); err == nil && info.IsDir() {
			startDir = cwd
		}
	}
	if startDir == "" {
		startDir = "."
	}
	cmd.Dir = startDir
	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, fmt.Errorf("pty start shell=%s cwd=%s: %w", shell, startDir, err)
	}
	p := &Pane{
		ID: id, Name: name,
		ptmx: ptmx, cmd: cmd,
		stream: outbuf.NewStream(context.Background(), bufMax),
		bch:    make(chan []byte, 256),
		done:   make(chan struct{}),
		onExit: onExit,
	}
	go p.readPTY()
	go p.drainBuf()
	log.Printf("[pane %s] started shell=%s pid=%d cwd=%s cols=%d rows=%d",
		id, shell, cmd.Process.Pid, startDir, cols, rows)
	return p, nil
}

func (p *Pane) drainBuf() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[pane %s] drainBuf panic: %v\n%s", p.ID, r, debug.Stack())
		}
	}()
	for d := range p.bch {
		p.stream.Feed(d)
	}
}

func (p *Pane) readPTY() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[pane %s] readPTY panic: %v\n%s", p.ID, r, debug.Stack())
		}
		close(p.bch)
	}()
	raw := make([]byte, 8192)
	for {
		n, err := p.ptmx.Read(raw)
		if err != nil {
			if err == io.EOF || strings.Contains(err.Error(), "input/output error") {
				log.Printf("[pane %s] readPTY: shell exited normally", p.ID)
			} else {
				log.Printf("[pane %s] readPTY unexpected error: %v", p.ID, err)
			}
			p.broadcast([]byte{OpExit})
			p.kill()
			if p.onExit != nil {
				go p.onExit(p.ID)
			}
			return
		}
		select {
		case p.bch <- append([]byte(nil), raw[:n]...):
		default:
			log.Printf("[pane %s] bch full, dropping %d bytes", p.ID, n)
		}
		msg := make([]byte, 1+n)
		msg[0] = OpOutput
		copy(msg[1:], raw[:n])
		p.broadcast(msg)
	}
}

func (p *Pane) broadcast(msg []byte) {
	p.cmu.Lock()
	snap := make([]*safeConn, len(p.cls))
	copy(snap, p.cls)
	p.cmu.Unlock()
	for _, c := range snap {
		if err := c.writeMsg(websocket.BinaryMessage, msg); err != nil {
			log.Printf("[pane %s] broadcast error addr=%s: %v", p.ID, c.remoteAddr(), err)
			p.removeClient(c)
			c.close()
		}
	}
}

func (p *Pane) addClient(c *safeConn) {
	p.cmu.Lock()
	p.cls = append(p.cls, c)
	n := len(p.cls)
	p.cmu.Unlock()
	log.Printf("[pane %s] client connected addr=%s total=%d", p.ID, c.remoteAddr(), n)
}

func (p *Pane) removeClient(c *safeConn) {
	p.cmu.Lock()
	for i, v := range p.cls {
		if v == c {
			p.cls = append(p.cls[:i], p.cls[i+1:]...)
			break
		}
	}
	n := len(p.cls)
	p.cmu.Unlock()
	log.Printf("[pane %s] client disconnected addr=%s remaining=%d", p.ID, c.remoteAddr(), n)
}

func (p *Pane) resize(c, r uint16) error {
	err := pty.Setsize(p.ptmx, &pty.Winsize{Cols: c, Rows: r})
	if err != nil {
		log.Printf("[pane %s] resize error cols=%d rows=%d: %v", p.ID, c, r, err)
	}
	return err
}

// Wait returns a channel closed when the pane terminates (test helper).
func (p *Pane) Wait() <-chan struct{} { return p.done }

// PTMX exposes the underlying PTY master for tests.
func (p *Pane) PTMX() *os.File { return p.ptmx }

// Stream exposes the output stream for tools.
func (p *Pane) Stream() *outbuf.Stream { return p.stream }

// CmdProcessPID returns the PID (0 if unavailable).
func (p *Pane) CmdProcessPID() int {
	if p.cmd == nil || p.cmd.Process == nil {
		return 0
	}
	return p.cmd.Process.Pid
}

func (p *Pane) kill() {
	p.once.Do(func() {
		log.Printf("[pane %s] killing pid=%d", p.ID, p.cmd.Process.Pid)
		close(p.done)
		p.ptmx.Close()
		if p.cmd.Process != nil {
			p.cmd.Process.Signal(syscall.SIGTERM)
			time.Sleep(50 * time.Millisecond)
			p.cmd.Process.Kill()
			if err := p.cmd.Wait(); err != nil {
				log.Printf("[pane %s] wait: %v", p.ID, err)
			}
		}
		p.stream.Close()
	})
}

// ── PaneManager ─────────────────────────────────────

type PaneManager struct {
	mu     sync.Mutex
	panes  map[string]*Pane
	nextID int

	dataDir     string
	invalidator func(paneID string)
	dirty       atomic.Bool
}

// NewPaneManager builds an empty manager. dataDir is where panes.json lives;
// invalidator is called whenever a pane dies so the workspace layer can prune
// its references (may be nil in tests).
func NewPaneManager(dataDir string, invalidator func(string)) *PaneManager {
	return &PaneManager{
		panes:       make(map[string]*Pane),
		dataDir:     dataDir,
		invalidator: invalidator,
	}
}

// SetInvalidator lets main register the workspace invalidation hook after
// wsMgr has been constructed (avoids a chicken-and-egg ordering issue).
func (m *PaneManager) SetInvalidator(f func(string)) {
	m.mu.Lock()
	m.invalidator = f
	m.mu.Unlock()
}

func (m *PaneManager) dataPath(name string) string {
	dir := m.dataDir
	if dir == "" {
		dir = "."
	}
	return filepath.Join(dir, name)
}

// Create spawns a new pane.
func (m *PaneManager) Create(cwd string, cols, rows uint16) (*Pane, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	id := strconv.Itoa(m.nextID)
	name := fmt.Sprintf("Shell #%d", m.nextID)
	p, err := StartPane(id, name, cwd, cols, rows, func(paneID string) {
		m.Delete(paneID)
		if m.invalidator != nil {
			m.invalidator(paneID)
		}
	})
	if err != nil {
		log.Printf("[pane %s] create error: %v", id, err)
		return nil, err
	}
	m.panes[id] = p
	log.Printf("[pane %s] registered total=%d", id, len(m.panes))
	m.dirty.Store(true)
	go m.SaveAll()
	return p, nil
}

func (m *PaneManager) Restore(id, name, cwd string, cols, rows uint16) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := StartPane(id, name, cwd, cols, rows, func(paneID string) {
		m.Delete(paneID)
		if m.invalidator != nil {
			m.invalidator(paneID)
		}
	})
	if err != nil {
		return err
	}
	p.restored = true
	m.panes[id] = p
	if n, _ := strconv.Atoi(id); n > m.nextID {
		m.nextID = n
	}
	log.Printf("[pane %s] restored total=%d", id, len(m.panes))
	return nil
}

func (m *PaneManager) Get(id string) *Pane {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.panes[id]
}

func (m *PaneManager) List() []map[string]interface{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []map[string]interface{}
	for _, p := range m.panes {
		pid := 0
		if p.cmd.Process != nil {
			pid = p.cmd.Process.Pid
		}
		out = append(out, map[string]interface{}{"id": p.ID, "name": p.Name, "pid": pid})
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["id"].(string) < out[j]["id"].(string) })
	return out
}

func (m *PaneManager) Delete(id string) {
	m.mu.Lock()
	p := m.panes[id]
	delete(m.panes, id)
	remaining := len(m.panes)
	m.mu.Unlock()
	if p != nil {
		p.kill()
		log.Printf("[pane %s] deleted remaining=%d", id, remaining)
	}
	m.dirty.Store(true)
	go m.SaveAll()
}

// IsLive implements the liveness interface consumed by workspace.Manager.
func (m *PaneManager) IsLive(id string) bool { return m.Get(id) != nil }

// ── persistence ──────────────────────────────────────

type PaneState struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Cwd  string `json:"cwd"`
}

// SaveAll writes panes.json. Skips when no state mutation has occurred since
// startup so a clean run never clobbers an existing user file with empty state.
func (m *PaneManager) SaveAll() {
	if !m.dirty.Load() {
		return
	}
	m.mu.Lock()
	var states []PaneState
	for _, p := range m.panes {
		states = append(states, PaneState{ID: p.ID, Name: p.Name, Cwd: p.Cwd()})
	}
	m.mu.Unlock()
	sort.Slice(states, func(i, j int) bool { return states[i].ID < states[j].ID })
	data, _ := json.Marshal(states)
	if err := os.WriteFile(m.dataPath("panes.json"), data, 0644); err != nil {
		log.Printf("savePanes: %v", err)
	}
}

// LoadAll reads panes.json and respawns shells.
func (m *PaneManager) LoadAll() {
	data, err := os.ReadFile(m.dataPath("panes.json"))
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("loadPanes: %v", err)
		}
		return
	}
	var states []PaneState
	if err := json.Unmarshal(data, &states); err != nil {
		log.Printf("loadPanes unmarshal: %v", err)
		return
	}
	for _, s := range states {
		if err := m.Restore(s.ID, s.Name, s.Cwd, 120, 40); err != nil {
			log.Printf("[pane %s] restore error: %v", s.ID, err)
		}
	}
	log.Printf("panes restored count=%d", len(states))
}

// Snapshot locks + copies pane pointers; used by adapters.
func (m *PaneManager) Snapshot() []*Pane {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Pane, 0, len(m.panes))
	for _, p := range m.panes {
		out = append(out, p)
	}
	return out
}

// ParseSize extracts cols/rows from request query.
func ParseSize(r *http.Request) (uint16, uint16) {
	c, ro := uint16(120), uint16(40)
	if v, err := strconv.ParseUint(r.URL.Query().Get("cols"), 10, 16); err == nil && v > 0 {
		c = uint16(v)
	}
	if v, err := strconv.ParseUint(r.URL.Query().Get("rows"), 10, 16); err == nil && v > 0 {
		ro = uint16(v)
	}
	return c, ro
}
