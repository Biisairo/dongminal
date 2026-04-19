package main

import (
	"bufio"
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
var serverStart = time.Now()

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
}

// ── Workspace (in-memory only) + Settings (file-persisted) ──

var (
	wsJSON []byte
	wsMu   sync.Mutex

	settingsJSON []byte
	settingsMu   sync.Mutex
)

func loadSettings() {
	data, err := os.ReadFile("settings.json")
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
	if err := os.WriteFile("settings.json", data, 0644); err != nil {
		log.Printf("saveSettings: %v", err)
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
		if snap := pane.buf.Snapshot(); len(snap) > 0 {
			msg := make([]byte, 1+len(snap))
			msg[0] = opOutput
			copy(msg[1:], snap)
			if err := conn.writeMsg(websocket.BinaryMessage, msg); err != nil {
				log.Printf("[pane %s] snapshot send error addr=%s: %v", pane.ID, r.RemoteAddr, err)
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
	loadSettings()
	initBinDir()

	staticFS, _ := fs.Sub(staticFiles, "static")
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(staticFS)))
	mux.HandleFunc("/ws", handleWS)
	mux.HandleFunc("/api/", handleAPI)

	server := &http.Server{Addr: ":" + port, Handler: loggingMiddleware(mux)}
	log.Printf("dongminal starting on :%s", port)

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		log.Printf("signal received: %v — shutting down", sig)
		saveSettings()
		server.Close()
	}()

	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("server fatal: %v", err)
	}
	log.Printf("server stopped")
}
