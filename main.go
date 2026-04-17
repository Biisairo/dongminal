package main

import (
	"embed"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
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
	cls  []*websocket.Conn
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
	// Inject cwd reporting hook
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
var serverStart = time.Now()

func (m *PaneManager) create(cwd string, cols, rows uint16) (*Pane, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	id := strconv.Itoa(m.nextID)
	name := fmt.Sprintf("Shell #%d", m.nextID)
	p, err := startPane(id, name, cwd, cols, rows)
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
		out = append(out, map[string]interface{}{"id": p.ID, "name": p.Name, "pid": pid})
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
		return
	}
	settingsJSON = data
}

func saveSettings() {
	settingsMu.Lock()
	data := settingsJSON
	settingsMu.Unlock()
	os.WriteFile("settings.json", data, 0644)
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

	// CPU usage
	cpu := 0.0
	if out, err := exec.Command("bash", "-c", `top -l 1 -n 0 | grep "CPU usage"`).Output(); err == nil {
		parts := strings.Fields(string(out))
		if len(parts) >= 5 {
			u, _ := strconv.ParseFloat(strings.TrimSuffix(parts[2], "%"), 64)
			s, _ := strconv.ParseFloat(strings.TrimSuffix(parts[4], "%"), 64)
			cpu = math.Round((u+s)*10) / 10
		}
	}

	// Memory
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

	// Disk
	diskPct := 0.0
	var stat syscall.Statfs_t
	if syscall.Statfs("/", &stat) == nil {
		used := stat.Blocks - stat.Bavail
		diskPct = math.Round(float64(used)/float64(stat.Blocks)*1000) / 10
	}

	// Uptime (system + server)
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
		// Security: only allow absolute paths or relative under cwd
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
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
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
		pane, err = pm.create("", cols, rows)
		if err != nil {
			wsSend(conn, opError, []byte("create failed"))
			return
		}
	}

	conn.SetWriteDeadline(time.Now().Add(pingPeriod + writeWait))
	pane.addClient(conn)
	defer pane.removeClient(conn)

	wsSend(conn, opSID, []byte(pane.ID))

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
	// download command
	dlScript := `#!/bin/sh
path=$(realpath "$1" 2>/dev/null || echo "$1")
printf '\033]777;Download;%s\007' "$path"
`
	os.WriteFile(filepath.Join(binDir, "download"), []byte(dlScript), 0755)

	// zsh hook (ZDOTDIR approach)
	zdotdir := filepath.Join(binDir, "zdotdir")
	os.MkdirAll(zdotdir, 0755)
	zshrc := `[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"
_rt_cwd_hook() { printf '\033]777;Cwd;%s\007' "$PWD" }
autoload -Uz add-zsh-hook
add-zsh-hook precmd _rt_cwd_hook
add-zsh-hook chpwd _rt_cwd_hook
`
	os.WriteFile(filepath.Join(zdotdir, ".zshrc"), []byte(zshrc), 0644)

	// bash hook
	bashHook := `_rt_cwd_hook() { printf '\033]777;Cwd;%s\007' "$PWD"; }
PROMPT_COMMAND="_rt_cwd_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
`
	os.WriteFile(filepath.Join(binDir, "bash-hook.sh"), []byte(bashHook), 0644)
}

func main() {
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

	server := &http.Server{Addr: ":" + port, Handler: mux}
	log.Printf("remote-terminal on :%s", port)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() { <-sigCh; saveSettings(); server.Close() }()

	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("server: %v", err)
	}
}
