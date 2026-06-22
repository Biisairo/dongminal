package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/user"
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

// Pane invariants:
//   - cmu protects cls and exited.
//   - broadcast/addClient/removeClient must NOT be called by a caller
//     already holding cmu (these methods acquire cmu themselves).
//   - Once exited=true, broadcast becomes a no-op and addClient rejects
//     new clients (sending OpExit immediately, outside cmu).
//   - The exited transition happens exactly once, inside kill() under
//     the protection of `once`.
type Pane struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	PID      int    `json:"pid"`
	ptmx     *os.File
	cmd      *exec.Cmd
	stream   *outbuf.Stream
	cmu      sync.Mutex
	cls      []*safeConn
	exited   bool
	done     chan struct{}
	once     sync.Once
	onExit   func(id string)
	restored bool

	// Attention state (PANE_ATTENTION_NOTIFY_SRS). attnCarry is touched only
	// by the readPTY goroutine (no lock). The atomics are shared with the
	// idle sweeper / input / query goroutines. onAttention/onAttentionClear/
	// allowBell are set once in StartPane before readPTY starts (race-free).
	lastOutputAt     atomic.Int64
	attnArmed        atomic.Bool
	attention        atomic.Bool
	attnCarry        []byte
	allowBell        bool
	onAttention      func(id, reason string)
	onAttentionClear func(id string)
}

// paneBusyProbe is the busy-detection function used by Pane.IsBusy. It is a
// package variable so tests can substitute a deterministic probe instead of
// relying on the host's pgrep behavior. The default implementation matches the
// historical behavior: a pane is "busy" when it has any direct child process.
var paneBusyProbe = func(pid int) bool {
	out, err := exec.Command("pgrep", "-P", strconv.Itoa(pid)).Output()
	if err != nil {
		return false
	}
	return len(strings.TrimSpace(string(out))) > 0
}

func (p *Pane) IsBusy() bool {
	if p.cmd == nil || p.cmd.Process == nil {
		return false
	}
	return paneBusyProbe(p.cmd.Process.Pid)
}

func (p *Pane) Cwd() string {
	if p.cmd != nil && p.cmd.Process != nil {
		// Linux: /proc/PID/cwd is a symlink — instant read.
		cwd, _ := os.Readlink(fmt.Sprintf("/proc/%d/cwd", p.cmd.Process.Pid))
		if cwd != "" {
			return cwd
		}
		// macOS fallback: lsof restricted to (a)nd of (p)id and (d)escriptor=cwd.
		// Without -a + -d cwd this would dump the entire fd table for the
		// process AND every other process whose cwd matches a path filter,
		// which is dramatically slower on busy machines (10× or more).
		out, _ := exec.Command("lsof", "-a", "-p", fmt.Sprintf("%d", p.cmd.Process.Pid), "-d", "cwd", "-Fn").Output()
		for _, l := range strings.Split(string(out), "\n") {
			if strings.HasPrefix(l, "n") {
				return strings.TrimPrefix(l, "n")
			}
		}
	}
	cwd, _ := os.Getwd()
	return cwd
}

// PaneHooks carries the attention wiring StartPane applies before launching
// readPTY (race-free). A nil *PaneHooks disables attention for that pane.
type PaneHooks struct {
	OnAttention      func(id, reason string)
	OnAttentionClear func(id string)
	AllowBell        bool
}

// StartPane spawns a shell under a new PTY. Exported for pane manager + tests.
func StartPane(id, name, cwd string, cols, rows uint16, onExit func(string), hooks *PaneHooks) (*Pane, error) {
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
	// Ensure critical env vars are always present (os.Environ() may lack
	// these when the server runs as a daemon / LaunchAgent).
	env := []string{
		"TERM=xterm-256color", "COLORTERM=truecolor",
		"LANG=en_US.UTF-8", "LC_ALL=en_US.UTF-8", "LC_CTYPE=en_US.UTF-8",
		"PATH=" + os.Getenv("PATH") + ":" + binDir,
		"HOME=" + home,
		// PANE_ATTENTION_NOTIFY_SRS: lets `dmctl notify` (incl. detached agent
		// hooks that have no controlling tty) identify this pane to the server.
		"DONGMINAL_PANE_ID=" + id,
	}
	if u, err := user.Current(); err == nil {
		env = append(env, "USER="+u.Username, "LOGNAME="+u.Username)
	}
	env = append(env, "SHELL="+shell)
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
		done:   make(chan struct{}),
		onExit: onExit,
	}
	if hooks != nil {
		p.onAttention = hooks.OnAttention
		p.onAttentionClear = hooks.OnAttentionClear
		p.allowBell = hooks.AllowBell
	}
	go p.readPTY()
	log.Printf("[pane %s] started shell=%s pid=%d cwd=%s cols=%d rows=%d",
		id, shell, cmd.Process.Pid, startDir, cols, rows)
	return p, nil
}

// readPTY drains the PTY master, feeds the bounded stream buffer (single
// drop path: outbuf.Stream compaction → Stats.TotalBytesDrop), and
// fan-outs OpOutput messages to live clients. On EOF/IO error it triggers
// a single kill() (which itself emits the final OpExit) and signals onExit.
func (p *Pane) readPTY() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[pane %s] readPTY panic: %v\n%s", p.ID, r, debug.Stack())
		}
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
			p.kill()
			if p.onExit != nil {
				go p.onExit(p.ID)
			}
			return
		}
		// Single backpressure path: Stream.Feed never blocks; loss (if any)
		// is recorded in Stats.TotalBytesDrop.
		p.stream.Feed(append([]byte(nil), raw[:n]...))
		p.observeOutput(raw[:n])
		msg := make([]byte, 1+n)
		msg[0] = OpOutput
		copy(msg[1:], raw[:n])
		p.broadcast(msg)
	}
}

// broadcast delivers msg to all currently-registered clients. It is a no-op
// once the pane has transitioned to exited. Caller must NOT hold cmu.
func (p *Pane) broadcast(msg []byte) {
	p.cmu.Lock()
	if p.exited {
		p.cmu.Unlock()
		return
	}
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

// observeOutput records output activity and runs observe-only L1 detection on
// the raw chunk. Called from the readPTY goroutine only; attnCarry needs no
// lock. The live bytes are never mutated.
func (p *Pane) observeOutput(chunk []byte) { p.observeOutputAt(chunk, attnNow()) }

// observeOutputAt is observeOutput with an injectable timestamp (tests).
func (p *Pane) observeOutputAt(chunk []byte, now int64) {
	p.lastOutputAt.Store(now)
	p.attnArmed.Store(true)
	if p.onAttention == nil {
		return
	}
	scan := chunk
	if len(p.attnCarry) > 0 {
		scan = append(append([]byte(nil), p.attnCarry...), chunk...)
	}
	if bytes.IndexByte(scan, 0x1b) < 0 && bytes.IndexByte(scan, 0x07) < 0 {
		p.attnCarry = nil
		return
	}
	sig, carry := detectAttentionSignal(scan, p.allowBell, attnMaxCarry)
	p.attnCarry = carry
	if sig {
		p.setAttention("signaled")
	}
}

// setAttention transitions none→attention exactly once (edge), firing the
// notifier only on the transition (NFR-PAN-3). Returns true if it transitioned.
// Used by passive detection (L1 OSC, L2 idle) where re-alerting an already-
// flagged pane would be noise.
func (p *Pane) setAttention(reason string) bool {
	if p.attention.CompareAndSwap(false, true) {
		if p.onAttention != nil {
			p.onAttention(p.ID, reason)
		}
		return true
	}
	return false
}

// signalAttention raises attention and ALWAYS notifies (not edge-gated). Used
// by explicit agent signals (`dmctl notify` → set endpoint): each discrete
// completion/waiting event must re-alert the user even if a prior unattended
// alarm is still active. The state itself stays idempotent (already-true).
func (p *Pane) signalAttention(reason string) {
	p.attention.Store(true)
	if p.onAttention != nil {
		p.onAttention(p.ID, reason)
	}
}

// clearAttention transitions attention→none exactly once, firing the clear
// notifier only on the transition.
func (p *Pane) clearAttention() bool {
	if p.attention.CompareAndSwap(true, false) {
		if p.onAttentionClear != nil {
			p.onAttentionClear(p.ID)
		}
		return true
	}
	return false
}

// attend marks the pane as attended-to: disarms idle and clears attention.
// Invoked only via the explicit focus/clear endpoints — NOT on raw WS input,
// because xterm replies to terminal queries (cursor-position/device-attribute
// reports an agent's TUI emits) arrive as OpInput too and would spuriously
// clear a just-raised alarm. Real "user attended" is signalled by focus.
func (p *Pane) attend() {
	p.attnArmed.Store(false)
	p.clearAttention()
}

// attnBusyProbe reports whether a pane has a running foreground process. It is
// a package variable so tests can substitute a deterministic probe.
var attnBusyProbe = func(p *Pane) bool { return p.IsBusy() }

// maybeIdle fires L2 (idle) attention when an armed pane has been quiet for at
// least threshold. It disarms after firing so it fires once per quiet edge;
// new output re-arms it. threshold<=0 disables L2. Idle only fires when a
// foreground process (e.g. an agent) is actually running — a bare shell sitting
// at its prompt is not "waiting on the user" and must not raise an alarm (this
// is what otherwise floods the UI with bogus alarms after a daemon restart).
func (p *Pane) maybeIdle(now, threshold int64) {
	if threshold <= 0 || !p.attnArmed.Load() {
		return
	}
	if now-p.lastOutputAt.Load() < threshold {
		return
	}
	p.attnArmed.Store(false)
	if !attnBusyProbe(p) {
		return
	}
	p.setAttention("idle")
}

// Attention reports whether the pane currently needs attention.
func (p *Pane) Attention() bool { return p.attention.Load() }

// addClient registers c. Returns false when the pane has already exited; in
// that case OpExit is sent to c immediately (outside cmu) and c is left
// untouched in the caller's possession. Caller must NOT hold cmu.
func (p *Pane) addClient(c *safeConn) bool {
	p.cmu.Lock()
	if p.exited {
		p.cmu.Unlock()
		c.send(OpExit, nil)
		log.Printf("[pane %s] addClient after exit addr=%s — sent OpExit", p.ID, c.remoteAddr())
		return false
	}
	p.cls = append(p.cls, c)
	n := len(p.cls)
	p.cmu.Unlock()
	log.Printf("[pane %s] client connected addr=%s total=%d", p.ID, c.remoteAddr(), n)
	return true
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

// kill transitions the pane to exited exactly once: it marks exited under
// cmu, fans out a final OpExit to the clients that were registered at that
// moment (outside cmu), then tears down the PTY/process and stream.
func (p *Pane) kill() {
	p.once.Do(func() {
		// Phase 1: atomic mark + snapshot under cmu.
		p.cmu.Lock()
		p.exited = true
		snap := make([]*safeConn, len(p.cls))
		copy(snap, p.cls)
		p.cmu.Unlock()

		// Phase 2: final OpExit broadcast outside cmu. Errors are ignored —
		// the pane is dying anyway and clients will close on their side.
		exitMsg := []byte{OpExit}
		for _, c := range snap {
			_ = c.writeMsg(websocket.BinaryMessage, exitMsg)
		}

		// Phase 3: tear down PTY/process/stream.
		pid := 0
		if p.cmd != nil && p.cmd.Process != nil {
			pid = p.cmd.Process.Pid
		}
		log.Printf("[pane %s] killing pid=%d", p.ID, pid)
		close(p.done)
		if p.ptmx != nil {
			p.ptmx.Close()
		}
		if p.cmd != nil && p.cmd.Process != nil {
			p.cmd.Process.Signal(syscall.SIGTERM)
			time.Sleep(50 * time.Millisecond)
			p.cmd.Process.Kill()
			if err := p.cmd.Wait(); err != nil {
				log.Printf("[pane %s] wait: %v", p.ID, err)
			}
		}
		if p.stream != nil {
			p.stream.Close()
		}
	})
}

// ── PaneManager ─────────────────────────────────────

type PaneManager struct {
	mu     sync.RWMutex
	panes  map[string]*Pane
	nextID int

	dataDir     string
	invalidator func(paneID string)
	dirty       atomic.Bool

	// Attention (PANE_ATTENTION_NOTIFY_SRS): idleThreshold/allowBell configure
	// detection; attnNotify/attnClear bridge transitions to SSE (set via
	// SetAttentionNotifier from the composition root).
	idleThreshold int64 // nanos, 0 disables L2
	allowBell     bool
	attnNotify    func(id, reason string)
	attnClear     func(id string)
}

// NewPaneManager builds an empty manager. dataDir is where panes.json lives;
// invalidator is called whenever a pane dies so the workspace layer can prune
// its references (may be nil in tests).
func NewPaneManager(dataDir string, invalidator func(string)) *PaneManager {
	return &PaneManager{
		panes:         make(map[string]*Pane),
		dataDir:       dataDir,
		invalidator:   invalidator,
		idleThreshold: int64(attentionIdleThreshold()),
		allowBell:     attentionAllowBell(),
	}
}

// SetAttentionNotifier wires pane attention transitions to broadcasts. Called
// from the composition root after the CommandHub exists (mirrors
// SetInvalidator). Must be called before panes are created so Create/Restore
// hand the hooks to StartPane.
func (m *PaneManager) SetAttentionNotifier(notify func(id, reason string), clear func(id string)) {
	m.mu.Lock()
	m.attnNotify = notify
	m.attnClear = clear
	m.mu.Unlock()
}

// attnHooks builds the per-pane hooks from the manager's notifier config.
func (m *PaneManager) attnHooks() *PaneHooks {
	if m.attnNotify == nil && m.attnClear == nil {
		return nil
	}
	return &PaneHooks{OnAttention: m.attnNotify, OnAttentionClear: m.attnClear, AllowBell: m.allowBell}
}

// sweepIdle runs one L2 idle pass at the given time. Exposed for deterministic
// tests; the goroutine in StartAttentionSweeper calls it on each tick.
func (m *PaneManager) sweepIdle(now int64) {
	m.mu.RLock()
	panes := make([]*Pane, 0, len(m.panes))
	for _, p := range m.panes {
		panes = append(panes, p)
	}
	threshold := m.idleThreshold
	m.mu.RUnlock()
	for _, p := range panes {
		p.maybeIdle(now, threshold)
	}
}

// StartAttentionSweeper launches the L2 idle sweeper goroutine. stop closes on
// server shutdown. No-op when L2 is disabled (idleThreshold<=0).
func (m *PaneManager) StartAttentionSweeper(stop <-chan struct{}) {
	if m.idleThreshold <= 0 {
		return
	}
	go func() {
		t := time.NewTicker(attnTickMS * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				m.sweepIdle(attnNow())
			case <-stop:
				return
			}
		}
	}()
}

// AttentionIDs returns the ids of panes currently needing attention (FR-PAN-8).
func (m *PaneManager) AttentionIDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var ids []string
	for id, p := range m.panes {
		if p.Attention() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// ClearAllAttention attends to every pane currently needing attention and
// returns how many were cleared (FR-PAN-17, bulk dismiss).
func (m *PaneManager) ClearAllAttention() int {
	m.mu.RLock()
	panes := make([]*Pane, 0, len(m.panes))
	for _, p := range m.panes {
		panes = append(panes, p)
	}
	m.mu.RUnlock()
	n := 0
	for _, p := range panes {
		if p.Attention() {
			p.attend()
			n++
		}
	}
	return n
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
	}, m.attnHooks())
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
	}, m.attnHooks())
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
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.panes[id]
}

func (m *PaneManager) List() []map[string]interface{} {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var out []map[string]interface{}
	for _, p := range m.panes {
		pid := 0
		if p.cmd.Process != nil {
			pid = p.cmd.Process.Pid
		}
		cols, rows := 0, 0
		if p.ptmx != nil {
			if r, c, err := pty.Getsize(p.ptmx); err == nil {
				cols, rows = c, r
			}
		}
		out = append(out, map[string]interface{}{
			"id": p.ID, "name": p.Name, "pid": pid,
			"sizeCols": cols, "sizeRows": rows,
		})
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
//
// Cwd() can take tens to hundreds of ms on macOS (lsof). To keep it from
// blocking concurrent Create/Delete calls, we snapshot pane pointers under
// m.mu and then call Cwd() OUTSIDE the lock.
func (m *PaneManager) SaveAll() {
	if !m.dirty.Load() {
		return
	}
	m.mu.Lock()
	snap := make([]*Pane, 0, len(m.panes))
	for _, p := range m.panes {
		snap = append(snap, p)
	}
	m.mu.Unlock()
	states := make([]PaneState, 0, len(snap))
	for _, p := range snap {
		states = append(states, PaneState{ID: p.ID, Name: p.Name, Cwd: p.Cwd()})
	}
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
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]*Pane, 0, len(m.panes))
	for _, p := range m.panes {
		out = append(out, p)
	}
	return out
}

// MaxTerminalDim is the upper bound (inclusive) accepted for cols and rows.
// Values above this clamp back to the default to reject pathological inputs.
const MaxTerminalDim uint64 = 4096

// ParseSize extracts cols/rows from request query.
// Out-of-range (0 or > MaxTerminalDim) or unparseable values fall back to defaults (120, 40).
func ParseSize(r *http.Request) (uint16, uint16) {
	c, ro := uint16(120), uint16(40)
	if v, err := strconv.ParseUint(r.URL.Query().Get("cols"), 10, 16); err == nil && v > 0 && v <= MaxTerminalDim {
		c = uint16(v)
	}
	if v, err := strconv.ParseUint(r.URL.Query().Get("rows"), 10, 16); err == nil && v > 0 && v <= MaxTerminalDim {
		ro = uint16(v)
	}
	return c, ro
}
