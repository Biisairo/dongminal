package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"dongminal/internal/mdscroll"
	"dongminal/internal/workspace"
)

// settingsStore is a simple JSON blob persisted to <dataDir>/settings.json.
type settingsStore struct {
	mu   sync.Mutex
	raw  []byte
	path string
}

func newSettingsStore(path string) *settingsStore {
	s := &settingsStore{path: path}
	data, err := os.ReadFile(path)
	if err == nil {
		s.raw = data
		log.Printf("settings loaded %d bytes", len(data))
	} else if !os.IsNotExist(err) {
		log.Printf("loadSettings: %v", err)
	}
	return s
}

func (s *settingsStore) get() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.raw
}

func (s *settingsStore) set(b []byte) {
	s.mu.Lock()
	s.raw = b
	s.mu.Unlock()
}

func (s *settingsStore) save() {
	s.mu.Lock()
	data := s.raw
	s.mu.Unlock()
	if len(data) == 0 {
		return
	}
	if err := os.WriteFile(s.path, data, 0644); err != nil {
		log.Printf("saveSettings: %v", err)
	}
}

func fmtDuration(d time.Duration) string {
	if d.Hours() >= 24 {
		return fmt.Sprintf("%dd %dh", int(d.Hours()/24), int(d.Hours())%24)
	} else if d.Hours() >= 1 {
		return fmt.Sprintf("%dh %dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%dm", int(d.Minutes()))
}

func (s *Server) getStats() map[string]interface{} {
	hostname, _ := os.Hostname()

	cpu := 0.0
	if out, err := exec.Command("bash", "-c", `top -l 1 -n 0 | grep "CPU usage"`).Output(); err == nil {
		parts := strings.Fields(string(out))
		if len(parts) >= 5 {
			u, _ := strconv.ParseFloat(strings.TrimSuffix(parts[2], "%"), 64)
			sv, _ := strconv.ParseFloat(strings.TrimSuffix(parts[4], "%"), 64)
			cpu = math.Round((u+sv)*10) / 10
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
	srvUptime := fmtDuration(time.Since(s.started))

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

// apiRoute couples a method+path matcher with the handler. The first matching
// route is dispatched; non-match falls through to 404.
type apiRoute struct {
	method string // "" matches any method
	match  func(path string) bool
	handle func(s *Server, w http.ResponseWriter, r *http.Request)
}

func exactPath(p string) func(string) bool {
	return func(s string) bool { return s == p }
}

var apiRoutes = []apiRoute{
	{http.MethodGet, exactPath("/api/state"), (*Server).apiStateGet},
	{http.MethodGet, exactPath("/api/whoami"), (*Server).apiWhoAmI},
	{http.MethodPost, exactPath("/api/panes"), (*Server).apiPanesCreate},
	{http.MethodGet, exactPath("/api/panes/attention"), (*Server).apiPanesAttention},
	{http.MethodPost, exactPath("/api/panes/attention/set"), (*Server).apiPaneAttentionSet},
	{http.MethodPost, exactPath("/api/panes/attention/clear"), (*Server).apiPaneAttentionClear},
	{http.MethodPost, exactPath("/api/panes/attention/clear-all"), (*Server).apiPaneAttentionClearAll},
	{http.MethodGet, func(p string) bool {
		return strings.HasPrefix(p, "/api/panes/") && strings.HasSuffix(p, "/busy")
	}, (*Server).apiPaneBusy},
	{http.MethodDelete, func(p string) bool { return strings.HasPrefix(p, "/api/panes/") }, (*Server).apiPaneDelete},
	{http.MethodGet, exactPath("/api/workspace"), (*Server).apiWorkspaceGet},
	{http.MethodPut, exactPath("/api/workspace"), (*Server).apiWorkspacePut},
	{http.MethodGet, exactPath("/api/settings"), (*Server).apiSettingsGet},
	{http.MethodPut, exactPath("/api/settings"), (*Server).apiSettingsPut},
	{http.MethodPost, exactPath("/api/upload"), (*Server).apiUpload},
	{http.MethodGet, exactPath("/api/download"), (*Server).apiDownload},
	{http.MethodGet, exactPath("/api/cwd"), (*Server).apiCwd},
	{http.MethodGet, exactPath("/api/code-server"), (*Server).apiCodeServerList},
	{http.MethodPost, exactPath("/api/code-server"), (*Server).apiCodeServerStart},
	{http.MethodPost, exactPath("/api/code-server/heartbeat"), (*Server).apiCodeServerHeartbeat},
	{http.MethodPost, exactPath("/api/code-server/stop"), (*Server).apiCodeServerStop},
	{"", exactPath("/api/ping"), (*Server).apiPing},
	{http.MethodGet, exactPath("/api/stats"), (*Server).apiStats},
	{http.MethodGet, exactPath("/api/md-file"), (*Server).apiMdFile},
	{http.MethodGet, exactPath("/api/md-scroll"), (*Server).apiMdScrollGet},
	{http.MethodPut, exactPath("/api/md-scroll"), (*Server).apiMdScrollPut},
}

func (s *Server) handleAPI(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	for _, rt := range apiRoutes {
		if rt.method != "" && rt.method != r.Method {
			continue
		}
		if rt.match(p) {
			rt.handle(s, w, r)
			return
		}
	}
	http.Error(w, "not found", 404)
}

func (s *Server) apiStateGet(w http.ResponseWriter, r *http.Request) {
	if s.Panes == nil {
		http.Error(w, "panes unavailable", 500)
		return
	}
	var rawWS []byte
	var rev uint64
	if s.Work != nil {
		rawWS, rev = s.Work.Snapshot()
	}
	var ws interface{}
	if len(rawWS) > 0 {
		json.Unmarshal(rawWS, &ws)
	}
	w.Header().Set("ETag", strconv.FormatUint(rev, 10))
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"panes":     s.Panes.List(),
		"workspace": ws,
	})
}

func (s *Server) apiPanesCreate(w http.ResponseWriter, r *http.Request) {
	if s.Panes == nil {
		http.Error(w, "panes unavailable", 500)
		return
	}
	cols, rows := ParseSize(r)
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		if refID := r.URL.Query().Get("cwdPane"); refID != "" {
			if ref := s.Panes.Get(refID); ref != nil {
				cwd = ref.Cwd()
			}
		}
	}
	pane, err := s.Panes.Create(cwd, cols, rows)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"id": pane.ID, "name": pane.Name})
}

func (s *Server) apiPaneBusy(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/panes/"), "/busy")
	var busy bool
	if s.Panes != nil {
		if pane := s.Panes.Get(id); pane != nil {
			busy = pane.IsBusy()
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"busy": busy})
}

// apiPanesAttention returns the ids of panes currently needing attention, so a
// late-joining / reconnecting client can restore highlights (FR-PAN-8).
func (s *Server) apiPanesAttention(w http.ResponseWriter, r *http.Request) {
	ids := []string{}
	if al, ok := s.Panes.(interface{ AttentionIDs() []string }); ok {
		if got := al.AttentionIDs(); got != nil {
			ids = got
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"paneIds": ids})
}

// apiPaneAttentionSet flags a pane as needing attention. Used by `dmctl notify`
// (agent hook bridge) which identifies its pane via DONGMINAL_PANE_ID — this
// works from detached hooks that have no controlling terminal. Body:
// {"paneId":"...","reason":"done|waiting|..."}. Unknown pane is a 200 no-op;
// missing paneId is 400.
func (s *Server) apiPaneAttentionSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PaneID string `json:"paneId"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.PaneID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	reason := req.Reason
	if reason == "" {
		reason = "signaled"
	}
	if s.Panes != nil {
		if pane := s.Panes.Get(req.PaneID); pane != nil {
			pane.signalAttention(reason)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// apiPaneAttentionClear clears a pane's attention (and broadcasts the clear)
// when the user focuses/opens it. Body: {"paneId":"..."}. Unknown/idle pane is
// a no-op (200) so a stale focus event never errors.
func (s *Server) apiPaneAttentionClear(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PaneID string `json:"paneId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.PaneID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if s.Panes != nil {
		if pane := s.Panes.Get(req.PaneID); pane != nil {
			pane.attend()
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// apiPaneAttentionClearAll dismisses every pane's attention at once (FR-PAN-17).
func (s *Server) apiPaneAttentionClearAll(w http.ResponseWriter, r *http.Request) {
	cleared := 0
	if ca, ok := s.Panes.(interface{ ClearAllAttention() int }); ok {
		cleared = ca.ClearAllAttention()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"cleared": cleared})
}

func (s *Server) apiPaneDelete(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/panes/")
	if s.Panes != nil {
		s.Panes.Delete(id)
	}
	w.WriteHeader(200)
}

func (s *Server) apiWorkspaceGet(w http.ResponseWriter, r *http.Request) {
	var raw []byte
	var rev uint64
	if s.Work != nil {
		raw, rev = s.Work.Snapshot()
	}
	w.Header().Set("ETag", strconv.FormatUint(rev, 10))
	w.Header().Set("Content-Type", "application/json")
	if len(raw) > 0 {
		w.Write(raw)
	} else {
		w.Write([]byte("null"))
	}
}

func (s *Server) apiWorkspacePut(w http.ResponseWriter, r *http.Request) {
	if s.Work == nil {
		http.Error(w, "workspace unavailable", 500)
		return
	}
	body, _ := io.ReadAll(r.Body)
	ifMatch := r.Header.Get("If-Match")
	rev, err := s.Work.Save(body, ifMatch)
	if err != nil {
		if errors.Is(err, workspace.ErrStale) {
			w.Header().Set("ETag", strconv.FormatUint(s.Work.CurrentRev(), 10))
			http.Error(w, "stale revision", http.StatusConflict)
			return
		}
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	w.Header().Set("ETag", strconv.FormatUint(rev, 10))
	w.WriteHeader(200)
	if s.Commands != nil {
		payload, _ := json.Marshal(map[string]any{
			"action": "workspace_changed",
			"args":   map[string]any{"rev": rev},
		})
		s.Commands.Broadcast(payload)
	}
}

func (s *Server) apiSettingsGet(w http.ResponseWriter, r *http.Request) {
	var data []byte
	if s.Settings != nil {
		data = s.Settings.get()
	}
	w.Header().Set("Content-Type", "application/json")
	if len(data) > 0 {
		w.Write(data)
	} else {
		w.Write([]byte("{}"))
	}
}

func (s *Server) apiSettingsPut(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	if s.Settings != nil {
		s.Settings.set(body)
		s.Settings.save()
	}
	w.WriteHeader(200)
}

func (s *Server) apiUpload(w http.ResponseWriter, r *http.Request) {
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
}

func (s *Server) apiDownload(w http.ResponseWriter, r *http.Request) {
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
}

func (s *Server) apiCwd(w http.ResponseWriter, r *http.Request) {
	paneID := r.URL.Query().Get("pane")
	var cwd string
	if paneID != "" && s.Panes != nil {
		if pane := s.Panes.Get(paneID); pane != nil {
			cwd = pane.Cwd()
		}
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"cwd": cwd})
}

func (s *Server) apiCodeServerList(w http.ResponseWriter, r *http.Request) {
	var list []map[string]interface{}
	if s.CS != nil {
		list = s.CS.List()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

func (s *Server) apiCodeServerStart(w http.ResponseWriter, r *http.Request) {
	if s.CS == nil {
		http.Error(w, "code-server unavailable", 500)
		return
	}
	folder := r.URL.Query().Get("path")
	inst, err := s.CS.Start(folder)
	if err != nil {
		log.Printf("code-server start error: %v", err)
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"id": inst.ID, "path": "/cs/" + inst.ID + "/", "folder": inst.Folder,
	})
}

func (s *Server) apiCodeServerHeartbeat(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if s.CS == nil || !s.CS.Touch(id) {
		http.Error(w, "not found", 404)
		return
	}
	w.WriteHeader(200)
}

func (s *Server) apiCodeServerStop(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if s.CS != nil {
		s.CS.Stop(id)
	}
	w.WriteHeader(200)
}

func (s *Server) apiPing(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("ok"))
}

func (s *Server) apiStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.getStats())
}

func (s *Server) apiMdFile(w http.ResponseWriter, r *http.Request) {
	fp := r.URL.Query().Get("path")
	if fp == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(fp) {
		http.Error(w, "path must be absolute", http.StatusBadRequest)
		return
	}
	ext := strings.ToLower(filepath.Ext(fp))
	if ext != ".md" && ext != ".mdown" && ext != ".markdown" {
		http.Error(w, "only markdown files (.md, .mdown, .markdown) are allowed", http.StatusForbidden)
		return
	}
	f, err := os.Open(fp)
	if err != nil {
		http.Error(w, "file not found", http.StatusNotFound)
		return
	}
	defer f.Close()
	stat, _ := f.Stat()
	if stat.IsDir() {
		http.Error(w, "not a file", http.StatusBadRequest)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	io.Copy(w, f)
}

func (s *Server) apiMdScrollGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if s.MdScroll == nil {
		w.Write([]byte(`{"tabs":{}}`))
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"tabs": s.MdScroll.Snapshot()})
}

type mdScrollPutReq struct {
	TabID string  `json:"tabId"`
	Top   float64 `json:"top"`
	Ratio float64 `json:"ratio"`
	By    string  `json:"by"`
}

func (s *Server) apiMdScrollPut(w http.ResponseWriter, r *http.Request) {
	if s.MdScroll == nil {
		http.Error(w, "md-scroll unavailable", http.StatusServiceUnavailable)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var req mdScrollPutReq
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if req.TabID == "" {
		http.Error(w, "tabId required", http.StatusBadRequest)
		return
	}
	if math.IsNaN(req.Top) || math.IsInf(req.Top, 0) || math.IsNaN(req.Ratio) || math.IsInf(req.Ratio, 0) {
		http.Error(w, "invalid number", http.StatusBadRequest)
		return
	}
	ts := time.Now().UnixMilli()
	entry := mdscroll.Entry{Top: req.Top, Ratio: req.Ratio, TS: ts}
	s.MdScroll.Set(req.TabID, entry)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "ts": ts})
	if s.Commands != nil {
		payload, _ := json.Marshal(map[string]any{
			"action": "md_scroll_changed",
			"args": map[string]any{
				"tabId": req.TabID,
				"top":   req.Top,
				"ratio": req.Ratio,
				"ts":    ts,
				"by":    req.By,
			},
		})
		s.Commands.Broadcast(payload)
	}
}
