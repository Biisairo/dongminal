package main

import (
	"bufio"
	"context"
	"embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime/debug"
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

// ── safeConn ─────────────────────────────────────────
// gorilla/websocket은 동시 쓰기 금지 — 모든 WriteMessage를 mutex로 직렬화

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

// ── Pane ────────────────────────────────────────────

type Pane struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	PID  int    `json:"pid"`
	ptmx *os.File
	cmd  *exec.Cmd
	buf  *OutputBuffer
	bch  chan []byte
	cmu  sync.Mutex
	cls  []*safeConn
	done chan struct{}
	once sync.Once
	// restored=true means this pane's shell was freshly re-spawned because
	// the server restarted. The first client to reconnect needs a mode
	// reset to clear stale DECSET state (mouse tracking, bracketed paste,
	// alt screen, SRM etc) left over in xterm from the previous session.
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
		// macOS fallback
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

func startPane(id, name, cwd string, cols, rows uint16) (*Pane, error) {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/bash"
	}
	if _, err := os.Stat(shell); os.IsNotExist(err) {
		shell = "/bin/sh"
	}
	home, _ := os.UserHomeDir()
	cmd := exec.Command(shell, "-l")
	binDir, _ := filepath.Abs(filepath.Join(".", "bin"))
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
		buf:  newOutputBuffer(bufMax),
		bch:  make(chan []byte, 256),
		done: make(chan struct{}),
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
		p.buf.Write(d)
	}
}

func (p *Pane) readPTY() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[pane %s] readPTY panic: %v\n%s", p.ID, r, debug.Stack())
		}
		close(p.bch) // drainBuf 고루틴 종료 트리거
	}()
	raw := make([]byte, 8192)
	for {
		n, err := p.ptmx.Read(raw)
		if err != nil {
			// EIO는 PTY slave(셸) 종료 시 정상 발생
			if err == io.EOF || strings.Contains(err.Error(), "input/output error") {
				log.Printf("[pane %s] readPTY: shell exited normally", p.ID)
			} else {
				log.Printf("[pane %s] readPTY unexpected error: %v", p.ID, err)
			}
			p.broadcast([]byte{opExit})
			p.kill()
			pm.delete(p.ID)
			return
		}
		select {
		case p.bch <- append([]byte(nil), raw[:n]...):
		default:
			log.Printf("[pane %s] bch full, dropping %d bytes", p.ID, n)
		}
		msg := make([]byte, 1+n)
		msg[0] = opOutput
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
	})
}

// ── PaneManager ─────────────────────────────────────

type PaneManager struct {
	mu     sync.Mutex
	panes  map[string]*Pane
	nextID int
}

var pm = &PaneManager{panes: make(map[string]*Pane)}
var csm = &CodeServerManager{insts: make(map[string]*CodeServerInst)}
var serverStart = time.Now()

// ── CodeServer ──────────────────────────────────────
// 각 edit 호출마다 별도의 code-server 프로세스 실행.
// 프론트가 hb를 보내지 않으면(=창 닫힘) 일정 시간 뒤 kill.

type CodeServerInst struct {
	ID        string
	Sock      string
	Folder    string
	Cmd       *exec.Cmd
	Proxy     *httputil.ReverseProxy
	CreatedAt time.Time
	LastPing  time.Time
	once      sync.Once
	done      chan struct{}
}

type CodeServerManager struct {
	mu    sync.Mutex
	insts map[string]*CodeServerInst
	seq   int
}

func (m *CodeServerManager) start(folder string) (*CodeServerInst, error) {
	bin, err := exec.LookPath("code-server")
	if err != nil {
		return nil, fmt.Errorf("code-server가 설치되어 있지 않습니다: %w", err)
	}
	if folder == "" {
		folder, _ = os.Getwd()
	}
	if info, err := os.Stat(folder); err != nil {
		return nil, fmt.Errorf("경로 없음: %s", folder)
	} else if !info.IsDir() {
		folder = filepath.Dir(folder)
	}
	m.mu.Lock()
	m.seq++
	id := fmt.Sprintf("cs%d", m.seq)
	m.mu.Unlock()

	sockDir := filepath.Join(os.TempDir(), "dongminal-cs")
	os.MkdirAll(sockDir, 0700)
	sock := filepath.Join(sockDir, id+".sock")
	os.Remove(sock)
	userDataDir := filepath.Join(sockDir, id+"-data")
	os.MkdirAll(userDataDir, 0755)

	cmd := exec.Command(bin,
		"--auth", "none",
		"--socket", sock,
		"--socket-mode", "600",
		"--disable-telemetry",
		"--disable-update-check",
		"--user-data-dir", userDataDir,
		"--extensions-dir", filepath.Join(userDataDir, "ext"),
		folder,
	)
	cmd.Env = os.Environ()
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("code-server 실행 실패: %w", err)
	}

	// 소켓 파일이 생성되고 accept 가능할 때까지 대기 (최대 15s)
	deadline := time.Now().Add(15 * time.Second)
	ready := false
	for time.Now().Before(deadline) {
		if c, err := net.DialTimeout("unix", sock, 500*time.Millisecond); err == nil {
			c.Close()
			ready = true
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !ready {
		cmd.Process.Kill()
		return nil, fmt.Errorf("code-server가 소켓 %s에서 응답하지 않음", sock)
	}

	// Unix socket dial하는 커스텀 Transport
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		},
	}
	backend, _ := url.Parse("http://unix")
	proxy := httputil.NewSingleHostReverseProxy(backend)
	proxy.Transport = transport
	prefix := "/cs/" + id
	origDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		req.URL.Path = strings.TrimPrefix(req.URL.Path, prefix)
		if req.URL.Path == "" {
			req.URL.Path = "/"
		}
		origDirector(req)
		// req.Host는 원본 유지 — code-server가 WS 검증 및 base URL 계산에 사용
		req.Header.Set("X-Forwarded-Proto", "http")
		req.Header.Set("X-Forwarded-Prefix", prefix)
		req.Header.Set("X-Forwarded-Host", req.Host)
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("[cs %s] proxy error %s %s: %v", id, r.Method, r.URL.Path, err)
		http.Error(w, "code-server unreachable", http.StatusBadGateway)
	}

	now := time.Now()
	inst := &CodeServerInst{
		ID: id, Sock: sock, Folder: folder,
		Cmd: cmd, Proxy: proxy,
		CreatedAt: now, LastPing: now,
		done: make(chan struct{}),
	}
	m.mu.Lock()
	m.insts[id] = inst
	m.mu.Unlock()
	log.Printf("[cs %s] started pid=%d sock=%s folder=%s", id, cmd.Process.Pid, sock, folder)

	go func() {
		cmd.Wait()
		log.Printf("[cs %s] process exited", id)
		m.stop(id)
	}()
	return inst, nil
}

func (m *CodeServerManager) list() []map[string]interface{} {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]map[string]interface{}, 0, len(m.insts))
	for _, inst := range m.insts {
		out = append(out, map[string]interface{}{
			"id":     inst.ID,
			"folder": inst.Folder,
			"path":   "/cs/" + inst.ID + "/",
			"age":    int(time.Since(inst.CreatedAt).Seconds()),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["id"].(string) < out[j]["id"].(string) })
	return out
}

func (m *CodeServerManager) get(id string) *CodeServerInst {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.insts[id]
}

func (m *CodeServerManager) touch(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if inst, ok := m.insts[id]; ok {
		inst.LastPing = time.Now()
		return true
	}
	return false
}

func (m *CodeServerManager) stop(id string) {
	m.mu.Lock()
	inst, ok := m.insts[id]
	if ok {
		delete(m.insts, id)
	}
	m.mu.Unlock()
	if !ok {
		return
	}
	inst.once.Do(func() {
		close(inst.done)
		if inst.Cmd != nil && inst.Cmd.Process != nil {
			inst.Cmd.Process.Signal(syscall.SIGTERM)
			time.Sleep(100 * time.Millisecond)
			inst.Cmd.Process.Kill()
		}
		if inst.Sock != "" {
			os.Remove(inst.Sock)
		}
		log.Printf("[cs %s] stopped", id)
	})
}

func (m *CodeServerManager) stopAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.insts))
	for id := range m.insts {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.stop(id)
	}
}

func (m *CodeServerManager) watchdog() {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for range t.C {
		now := time.Now()
		m.mu.Lock()
		stale := []string{}
		for id, inst := range m.insts {
			if now.Sub(inst.LastPing) > 30*time.Second {
				stale = append(stale, id)
			}
		}
		m.mu.Unlock()
		for _, id := range stale {
			log.Printf("[cs %s] heartbeat timeout, stopping", id)
			m.stop(id)
		}
	}
}

func dataPath(name string) string {
	dir := os.Getenv("DATA_DIR")
	if dir == "" {
		dir = "."
	}
	return filepath.Join(dir, name)
}

func (m *PaneManager) create(cwd string, cols, rows uint16) (*Pane, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	id := strconv.Itoa(m.nextID)
	name := fmt.Sprintf("Shell #%d", m.nextID)
	p, err := startPane(id, name, cwd, cols, rows)
	if err != nil {
		log.Printf("[pane %s] create error: %v", id, err)
		return nil, err
	}
	m.panes[id] = p
	log.Printf("[pane %s] registered total=%d", id, len(m.panes))
	go savePanes()
	return p, nil
}

func (m *PaneManager) restore(id, name, cwd string, cols, rows uint16) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, err := startPane(id, name, cwd, cols, rows)
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
		out = append(out, map[string]interface{}{"id": p.ID, "name": p.Name, "pid": pid})
	}
	sort.Slice(out, func(i, j int) bool { return out[i]["id"].(string) < out[j]["id"].(string) })
	return out
}

func (m *PaneManager) delete(id string) {
	m.mu.Lock()
	p := m.panes[id]
	delete(m.panes, id)
	remaining := len(m.panes)
	m.mu.Unlock()
	if p != nil {
		p.kill()
		log.Printf("[pane %s] deleted remaining=%d", id, remaining)
	}
	go savePanes()
}

// ── Workspace (in-memory only) + Settings (file-persisted) ──

var (
	wsJSON []byte
	wsMu   sync.Mutex

	settingsJSON []byte
	settingsMu   sync.Mutex
)

func loadSettings() {
	data, err := os.ReadFile(dataPath("settings.json"))
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("loadSettings: %v", err)
		}
		return
	}
	settingsJSON = data
	log.Printf("settings loaded %d bytes", len(data))
}

func saveSettings() {
	settingsMu.Lock()
	data := settingsJSON
	settingsMu.Unlock()
	if err := os.WriteFile(dataPath("settings.json"), data, 0644); err != nil {
		log.Printf("saveSettings: %v", err)
	}
}

type PaneState struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Cwd  string `json:"cwd"`
}

func savePanes() {
	pm.mu.Lock()
	var states []PaneState
	for _, p := range pm.panes {
		states = append(states, PaneState{ID: p.ID, Name: p.Name, Cwd: p.Cwd()})
	}
	pm.mu.Unlock()
	sort.Slice(states, func(i, j int) bool { return states[i].ID < states[j].ID })
	data, _ := json.Marshal(states)
	if err := os.WriteFile(dataPath("panes.json"), data, 0644); err != nil {
		log.Printf("savePanes: %v", err)
	}
}

func loadPanes() {
	data, err := os.ReadFile(dataPath("panes.json"))
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
		if err := pm.restore(s.ID, s.Name, s.Cwd, 120, 40); err != nil {
			log.Printf("[pane %s] restore error: %v", s.ID, err)
		}
	}
	log.Printf("panes restored count=%d", len(states))
}

func loadWorkspace() {
	data, err := os.ReadFile(dataPath("workspace.json"))
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("loadWorkspace: %v", err)
		}
		return
	}
	wsMu.Lock()
	wsJSON = data
	wsMu.Unlock()
	log.Printf("workspace loaded %d bytes", len(data))
}

func saveWorkspace() {
	wsMu.Lock()
	data := wsJSON
	wsMu.Unlock()
	if err := os.WriteFile(dataPath("workspace.json"), data, 0644); err != nil {
		log.Printf("saveWorkspace: %v", err)
	}
}

// ── HTTP logging middleware ──────────────────────────

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(rw, r)
		// ping/stats 는 너무 잦아서 제외
		if r.URL.Path != "/api/ping" && r.URL.Path != "/api/stats" {
			log.Printf("http %s %s %d %s addr=%s",
				r.Method, r.URL.Path, rw.status, time.Since(start).Round(time.Millisecond), r.RemoteAddr)
		}
	})
}

type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(status int) {
	rw.status = status
	rw.ResponseWriter.WriteHeader(status)
}

func (rw *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := rw.ResponseWriter.(http.Hijacker); ok {
		return h.Hijack()
	}
	return nil, nil, fmt.Errorf("ResponseWriter does not implement http.Hijacker")
}

func (rw *responseWriter) Flush() {
	if f, ok := rw.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// ── API ─────────────────────────────────────────────

func fmtDuration(d time.Duration) string {
	if d.Hours() >= 24 {
		return fmt.Sprintf("%dd %dh", int(d.Hours()/24), int(d.Hours())%24)
	} else if d.Hours() >= 1 {
		return fmt.Sprintf("%dh %dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%dm", int(d.Minutes()))
}

func getStats() map[string]interface{} {
	hostname, _ := os.Hostname()

	cpu := 0.0
	if out, err := exec.Command("bash", "-c", `top -l 1 -n 0 | grep "CPU usage"`).Output(); err == nil {
		parts := strings.Fields(string(out))
		if len(parts) >= 5 {
			u, _ := strconv.ParseFloat(strings.TrimSuffix(parts[2], "%"), 64)
			s, _ := strconv.ParseFloat(strings.TrimSuffix(parts[4], "%"), 64)
			cpu = math.Round((u+s)*10) / 10
		}
	}

	memTotal, memUsed := uint64(0), uint64(0)
	if out, err := exec.Command("sysctl", "-n", "hw.memsize").Output(); err == nil {
		if v, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64); err == nil {
			memTotal = v
		}
	}
	if memTotal > 0 {
		if out, err := exec.Command("vm_stat").Output(); err == nil {
			var freePages uint64
			for _, line := range strings.Split(string(out), "\n") {
				line = strings.TrimRight(line, ".")
				if strings.Contains(line, "Pages free") {
					fmt.Sscanf(line, "Pages free: %d", &freePages)
				} else if strings.Contains(line, "Pages inactive") {
					var v uint64
					fmt.Sscanf(line, "Pages inactive: %d", &v)
					freePages += v
				}
			}
			memUsed = memTotal - freePages*4096
		}
	}

	diskPct := 0.0
	var stat syscall.Statfs_t
	if syscall.Statfs("/", &stat) == nil {
		used := stat.Blocks - stat.Bavail
		diskPct = math.Round(float64(used)/float64(stat.Blocks)*1000) / 10
	}

	sysUptime := ""
	if out, err := exec.Command("sysctl", "-n", "kern.boottime").Output(); err == nil {
		if parts := strings.Split(string(out), "="); len(parts) >= 2 {
			secStr := strings.TrimSpace(strings.Split(parts[1], ",")[0])
			if sec, err := strconv.ParseInt(secStr, 10, 64); err == nil {
				sysUptime = fmtDuration(time.Since(time.Unix(sec, 0)))
			}
		}
	}
	srvUptime := fmtDuration(time.Since(serverStart))

	return map[string]interface{}{
		"hostname":  hostname,
		"cpu":       cpu,
		"memUsed":   memUsed,
		"memTotal":  memTotal,
		"diskPct":   diskPct,
		"sysUptime": sysUptime,
		"srvUptime": srvUptime,
	}
}

func handleAPI(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	switch {
	case p == "/api/state" && r.Method == http.MethodGet:
		wsMu.Lock()
		var ws interface{}
		if len(wsJSON) > 0 {
			json.Unmarshal(wsJSON, &ws)
		}
		wsMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"panes":     pm.list(),
			"workspace": ws,
		})

	case p == "/api/panes" && r.Method == http.MethodPost:
		cols, rows := parseSize(r)
		cwd := r.URL.Query().Get("cwd")
		pane, err := pm.create(cwd, cols, rows)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"id": pane.ID, "name": pane.Name})

	case strings.HasPrefix(p, "/api/panes/") && strings.HasSuffix(p, "/busy") && r.Method == http.MethodGet:
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/api/panes/"), "/busy")
		pane := pm.get(id)
		busy := pane != nil && pane.IsBusy()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"busy": busy})

	case strings.HasPrefix(p, "/api/panes/") && r.Method == http.MethodDelete:
		id := strings.TrimPrefix(p, "/api/panes/")
		pm.delete(id)
		w.WriteHeader(200)

	case p == "/api/workspace" && r.Method == http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		wsMu.Lock()
		wsJSON = body
		wsMu.Unlock()
		saveWorkspace()
		w.WriteHeader(200)

	case p == "/api/settings" && r.Method == http.MethodGet:
		settingsMu.Lock()
		data := settingsJSON
		settingsMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if len(data) > 0 {
			w.Write(data)
		} else {
			w.Write([]byte("{}"))
		}

	case p == "/api/settings" && r.Method == http.MethodPut:
		body, _ := io.ReadAll(r.Body)
		settingsMu.Lock()
		settingsJSON = body
		settingsMu.Unlock()
		saveSettings()
		w.WriteHeader(200)

	case p == "/api/upload" && r.Method == http.MethodPost:
		file, header, err := r.FormFile("file")
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		defer file.Close()
		dir := r.URL.Query().Get("dir")
		if dir == "" {
			dir = "."
		}
		outPath := uniquePath(dir, header.Filename)
		out, err := os.Create(outPath)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer out.Close()
		written, err := io.Copy(out, file)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"name": filepath.Base(outPath), "size": written, "path": outPath})

	case p == "/api/download" && r.Method == http.MethodGet:
		fp := r.URL.Query().Get("path")
		if fp == "" {
			http.Error(w, "missing path", 400)
			return
		}
		if !filepath.IsAbs(fp) {
			abs, err := filepath.Abs(fp)
			if err != nil {
				http.Error(w, err.Error(), 400)
				return
			}
			fp = abs
		}
		f, err := os.Open(fp)
		if err != nil {
			http.Error(w, err.Error(), 404)
			return
		}
		defer f.Close()
		stat, _ := f.Stat()
		w.Header().Set("Content-Disposition", "attachment; filename="+filepath.Base(fp))
		w.Header().Set("Content-Type", "application/octet-stream")
		if stat != nil {
			w.Header().Set("Content-Length", fmt.Sprintf("%d", stat.Size()))
		}
		io.Copy(w, f)

	case p == "/api/cwd" && r.Method == http.MethodGet:
		paneID := r.URL.Query().Get("pane")
		var cwd string
		if paneID != "" {
			pane := pm.get(paneID)
			if pane != nil {
				cwd = pane.Cwd()
			}
		}
		if cwd == "" {
			cwd, _ = os.Getwd()
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"cwd": cwd})

	case p == "/api/code-server" && r.Method == http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(csm.list())

	case p == "/api/code-server" && r.Method == http.MethodPost:
		folder := r.URL.Query().Get("path")
		inst, err := csm.start(folder)
		if err != nil {
			log.Printf("code-server start error: %v", err)
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"id": inst.ID, "path": "/cs/" + inst.ID + "/", "folder": inst.Folder,
		})

	case p == "/api/code-server/heartbeat" && r.Method == http.MethodPost:
		id := r.URL.Query().Get("id")
		if !csm.touch(id) {
			http.Error(w, "not found", 404)
			return
		}
		w.WriteHeader(200)

	case p == "/api/code-server/stop" && r.Method == http.MethodPost:
		id := r.URL.Query().Get("id")
		csm.stop(id)
		w.WriteHeader(200)

	case p == "/api/ping":
		w.Write([]byte("ok"))

	case p == "/api/stats" && r.Method == http.MethodGet:
		stats := getStats()
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)

	default:
		http.Error(w, "not found", 404)
	}
}

// ── code-server 리버스 프록시 ─────────────────────────

func handleCSProxy(w http.ResponseWriter, r *http.Request) {
	// /cs/<id>/... → 127.0.0.1:<port>/...
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
	inst := csm.get(id)
	if inst == nil {
		http.Error(w, "code-server session not found", http.StatusNotFound)
		return
	}
	// prefix 접근을 활동으로 간주 (새로 고침 등도 포함)
	csm.touch(id)
	// trailing slash 보장 — VS Code web은 base URL에 / 필요
	if r.URL.Path == "/cs/"+id {
		http.Redirect(w, r, "/cs/"+id+"/", http.StatusMovedPermanently)
		return
	}
	inst.Proxy.ServeHTTP(w, r)
}

// ── WebSocket ───────────────────────────────────────

func handleWS(w http.ResponseWriter, r *http.Request) {
	raw, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade addr=%s: %v", r.RemoteAddr, err)
		return
	}
	conn := newSafeConn(raw)
	defer conn.close()

	paneID := r.URL.Query().Get("pane")
	log.Printf("ws connected addr=%s pane=%s", r.RemoteAddr, paneID)

	cols, rows := parseSize(r)
	var pane *Pane

	if paneID != "" {
		pane = pm.get(paneID)
		if pane == nil {
			conn.send(opError, []byte("pane not found"))
			log.Printf("ws addr=%s: pane %s not found", r.RemoteAddr, paneID)
			return
		}
	} else {
		pane, err = pm.create("", cols, rows)
		if err != nil {
			conn.send(opError, []byte("create failed"))
			log.Printf("ws addr=%s: pane create error: %v", r.RemoteAddr, err)
			return
		}
	}

	pane.addClient(conn)
	defer pane.removeClient(conn)

	conn.send(opSID, []byte(pane.ID))

	if paneID != "" {
		// 서버 재시작으로 shell 이 재생성된 경우, xterm 에 남은 이전 세션의
		// DECSET(mouse tracking, bracketed paste, alt screen, SRM, hidden
		// cursor 등) 가 새 쉘 입력을 오염시킨다.
		// 또한 snapshot 버퍼에도 이전 세션의 DECSET 바이트가 섞여있을 수 있으므로
		// snapshot 을 먼저 재생하고 그 뒤에 reset 을 보내야 mouse 모드 등이
		// 확실히 꺼진다. (이전 구현은 reset → snapshot 이라 snapshot 안의
		// \x1b[?1000h 같은 바이트가 mouse 를 다시 켜는 버그가 있었다.)
		if snap := pane.buf.Snapshot(); len(snap) > 0 {
			msg := make([]byte, 1+len(snap))
			msg[0] = opOutput
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
			msg[0] = opOutput
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
		case opInput:
			if _, err := pane.ptmx.Write(msg[1:]); err != nil {
				log.Printf("[pane %s] ptmx write error: %v", pane.ID, err)
				return
			}
		case opResize:
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

func uniquePath(dir, name string) string {
	p := filepath.Join(dir, name)
	if _, err := os.Stat(p); err != nil {
		return p
	}
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i := 1; ; i++ {
		p = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, i, ext))
		if _, err := os.Stat(p); err != nil {
			return p
		}
	}
}

func initBinDir() {
	binDir := filepath.Join(".", "bin")
	os.MkdirAll(binDir, 0755)
	dlScript := `#!/bin/sh
path=$(realpath "$1" 2>/dev/null || echo "$1")
printf '\033]777;Download;%s\007' "$path"
`
	os.WriteFile(filepath.Join(binDir, "download"), []byte(dlScript), 0755)

	editScript := `#!/bin/sh
# edit — code-server 런처 (dongminal)
port="${DONGMINAL_PORT:-8080}"
base="http://127.0.0.1:${port}/api/code-server"

print_help() {
  cat <<'HLP'
사용법:
  edit <path>              해당 경로로 새 code-server 열기
  edit -l, --list          열린 code-server 목록 (URL 클릭 → 열기)
  edit -s, --stop <id|all> 인스턴스 종료 (id 또는 all)
  edit -h, --help, ?       이 도움말
HLP
}

case "${1:-}" in
  "" | -h | --help | "?" )
    print_help
    exit 0
    ;;
  -l | --list )
    resp=$(curl -sf "$base") || { echo "edit: 서버 연결 실패 (port=$port)" >&2; exit 1; }
    printf '\033]777;CodeServerList;%s\007' "$resp"
    exit 0
    ;;
  -s | --stop )
    target="${2:-}"
    if [ -z "$target" ]; then
      echo "사용법: edit -s <id|all>" >&2
      exit 1
    fi
    if [ "$target" = "all" ]; then
      ids=$(curl -sf "$base" | grep -oE '"id":"[^"]*"' | sed 's/"id":"\([^"]*\)"/\1/')
      if [ -z "$ids" ]; then
        echo "열린 인스턴스 없음"
        exit 0
      fi
      for i in $ids; do
        curl -sf -X POST "$base/stop?id=$i" >/dev/null && echo "stopped $i"
      done
    else
      curl -sf -X POST "$base/stop?id=$target" >/dev/null \
        && echo "stopped $target" \
        || { echo "edit: 실패 ($target)" >&2; exit 1; }
    fi
    exit 0
    ;;
  -* )
    echo "edit: 알 수 없는 옵션: $1" >&2
    print_help >&2
    exit 1
    ;;
esac

target="$1"
if [ ! -e "$target" ]; then
  echo "edit: 경로 없음: $target" >&2
  exit 1
fi
if [ -d "$target" ]; then
  abs=$(cd "$target" && pwd)
else
  abs=$(cd "$(dirname "$target")" && printf '%s/%s' "$(pwd)" "$(basename "$target")")
fi
enc=$(printf '%s' "$abs" | sed 's/ /%20/g')
resp=$(curl -sf -X POST "$base?path=${enc}")
if [ -z "$resp" ]; then
  echo "edit: 서버에 연결할 수 없음 (port=$port)" >&2
  exit 1
fi
id=$(printf '%s' "$resp" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
cs_path=$(printf '%s' "$resp" | sed -n 's/.*"path":"\([^"]*\)".*/\1/p')
folder=$(printf '%s' "$resp" | sed -n 's/.*"folder":"\([^"]*\)".*/\1/p')
if [ -z "$id" ] || [ -z "$cs_path" ]; then
  echo "edit: 실패 — $resp" >&2
  exit 1
fi
printf '\033]777;OpenCodeServer;%s|%s|%s\007' "$id" "$cs_path" "$folder"
printf 'VSCode(code-server) 열기: %s (folder=%s)\n' "$cs_path" "$folder"
`
	os.WriteFile(filepath.Join(binDir, "edit"), []byte(editScript), 0755)

	zdotdir := filepath.Join(binDir, "zdotdir")
	os.MkdirAll(zdotdir, 0755)
	zshrc := `export HISTFILE="$HOME/.zsh_history"
export SHELL_SESSIONS_DISABLE=1
export ZSH_COMPDUMP="$HOME/.zcompdump"
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"
_rt_cwd_hook() { printf '\033]777;Cwd;%s\007' "$PWD" }
autoload -Uz add-zsh-hook
add-zsh-hook precmd _rt_cwd_hook
add-zsh-hook chpwd _rt_cwd_hook
`
	os.WriteFile(filepath.Join(zdotdir, ".zshrc"), []byte(zshrc), 0644)

	bashHook := `_rt_cwd_hook() { printf '\033]777;Cwd;%s\007' "$PWD"; }
PROMPT_COMMAND="_rt_cwd_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
`
	os.WriteFile(filepath.Join(binDir, "bash-hook.sh"), []byte(bashHook), 0644)
}

func main() {
	log.SetFlags(log.Ldate | log.Ltime | log.Lmicroseconds)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	os.Setenv("DONGMINAL_PORT", port)
	if dir := os.Getenv("DATA_DIR"); dir != "" {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Fatalf("DATA_DIR 생성 실패: %v", err)
		}
	}
	loadSettings()
	loadWorkspace()
	loadPanes()
	initBinDir()
	go csm.watchdog()

	staticFS, _ := fs.Sub(staticFiles, "static")
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(staticFS)))
	mux.HandleFunc("/ws", handleWS)
	mux.HandleFunc("/api/", handleAPI)
	mux.HandleFunc("/cs/", handleCSProxy)
	mux.HandleFunc("/mcp/sse", handleMCPSSE)
	mux.HandleFunc("/mcp/message", handleMCPMessage)
	mux.HandleFunc("/api/commands/sse", handleCommandSSE)
	mux.HandleFunc("/api/commands", handleCommandPost)

	server := &http.Server{Addr: ":" + port, Handler: loggingMiddleware(mux)}
	log.Printf("dongminal starting on :%s", port)

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		log.Printf("signal received: %v — shutting down", sig)
		savePanes()
		saveSettings()
		csm.stopAll()
		server.Close()
	}()

	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("server fatal: %v", err)
	}
	log.Printf("server stopped")
}
