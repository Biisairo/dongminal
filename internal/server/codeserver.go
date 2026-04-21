package server

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

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

func NewCodeServerManager() *CodeServerManager {
	return &CodeServerManager{insts: make(map[string]*CodeServerInst)}
}

func (m *CodeServerManager) Start(folder string) (*CodeServerInst, error) {
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
		m.Stop(id)
	}()
	return inst, nil
}

func (m *CodeServerManager) List() []map[string]interface{} {
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

func (m *CodeServerManager) Get(id string) *CodeServerInst {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.insts[id]
}

func (m *CodeServerManager) Touch(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if inst, ok := m.insts[id]; ok {
		inst.LastPing = time.Now()
		return true
	}
	return false
}

func (m *CodeServerManager) Stop(id string) {
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

func (m *CodeServerManager) StopAll() {
	m.mu.Lock()
	ids := make([]string, 0, len(m.insts))
	for id := range m.insts {
		ids = append(ids, id)
	}
	m.mu.Unlock()
	for _, id := range ids {
		m.Stop(id)
	}
}

// Watchdog kills instances whose clients have stopped heartbeating.
func (m *CodeServerManager) Watchdog() {
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
			m.Stop(id)
		}
	}
}
