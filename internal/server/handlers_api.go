package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

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

// getStats 는 상태바 지표를 조립한다. 커널을 호출하지 않는다 — 샘플러가 갱신한
// 스냅샷을 읽을 뿐이므로 클라이언트 수와 무관하게 즉시 반환된다 (FR-STAT-9, 10, 11).
//
// 한 번도 유효하지 않았던 지표는 키 자체를 생략한다 (FR-STAT-7). 클라이언트의
// _updateStatusBar 는 각 키를 truthy / !==undefined 로 검사하므로 생략을 견딘다.
func (s *Server) getStats() map[string]interface{} {
	hostname, _ := os.Hostname()
	out := map[string]interface{}{
		"hostname":  hostname,
		"srvUptime": fmtDuration(time.Since(s.started)),
	}
	if s.Stats == nil {
		return out
	}
	snap := s.Stats.Snapshot()
	if snap.CPUValid {
		out["cpu"] = snap.CPU
	}
	if snap.MemValid {
		out["memUsed"] = snap.Mem.Used
		out["memTotal"] = snap.Mem.Total
	}
	if snap.DiskValid {
		out["diskPct"] = snap.DiskPct
	}
	if snap.BootValid {
		out["sysUptime"] = fmtDuration(time.Since(snap.BootTime))
	}
	return out
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

// safeResolve verifies that userPath resolves within baseDir, preventing
// path-traversal attacks.
func safeResolve(baseDir, userPath string) (string, error) {
	cleaned := filepath.Clean(userPath)
	if !filepath.IsAbs(cleaned) {
		var err error
		cleaned, err = filepath.Abs(cleaned)
		if err != nil {
			return "", err
		}
	}
	rel, err := filepath.Rel(baseDir, cleaned)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("path escapes base directory")
	}
	return cleaned, nil
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
	{http.MethodPost, exactPath("/api/tools"), (*Server).apiToolsCreate},
	{http.MethodGet, exactPath("/api/tools/attention"), (*Server).apiToolsAttention},
	{http.MethodPost, exactPath("/api/tools/attention/set"), (*Server).apiToolAttentionSet},
	{http.MethodPost, exactPath("/api/tools/attention/clear"), (*Server).apiToolAttentionClear},
	{http.MethodPost, exactPath("/api/tools/attention/clear-all"), (*Server).apiToolAttentionClearAll},
	{http.MethodGet, exactPath("/api/tools/activity"), (*Server).apiToolsActivity},
	// 에이전트 접합면 (SKILL_INJECTION_SRS FR-API-1/2/3). dmctl read-screen /
	// read-output / send-input / msg 가 호출한다.
	{http.MethodGet, exactPath("/api/tools/output"), (*Server).apiToolOutput},
	{http.MethodPost, exactPath("/api/tools/input"), (*Server).apiToolInput},
	{http.MethodPost, exactPath("/api/tools/message"), (*Server).apiToolMessage},
	{http.MethodGet, exactPath("/api/tools/background"), (*Server).apiToolsBackground},
	{http.MethodPost, exactPath("/api/tools/background/set"), (*Server).apiToolBackgroundSet},
	{http.MethodPost, exactPath("/api/tools/activity/set"), (*Server).apiToolActivitySet},
	// 묶음 S — 상태·대기 계약 (RUN_ORCHESTRATION_SRS FR-STA-1/2/3).
	// dmctl status / dmctl wait 가 호출한다.
	{http.MethodGet, exactPath("/api/tools/activity/get"), (*Server).apiToolStatus},
	{http.MethodGet, exactPath("/api/tools/activity/wait"), (*Server).apiToolStatusWait},
	// 묶음 R — Run 레코드 (RUN_ORCHESTRATION_SRS FR-RUN-1/2/8/11).
	{http.MethodGet, exactPath("/api/runs"), (*Server).apiRunsGet},
	{http.MethodPost, exactPath("/api/runs"), (*Server).apiRunStart},
	{http.MethodPost, exactPath("/api/runs/members"), (*Server).apiRunMemberAdd},
	{http.MethodPost, exactPath("/api/runs/report"), (*Server).apiRunReport},
	{http.MethodPost, exactPath("/api/runs/close"), (*Server).apiRunClose},
	// 묶음 P — 멤버 프리앰블 (RUN_ORCHESTRATION_SRS FR-PRE-1). dmctl run launch.
	{http.MethodGet, exactPath("/api/runs/preamble"), (*Server).apiRunPreamble},
	{http.MethodGet, func(p string) bool {
		return strings.HasPrefix(p, "/api/tools/") && strings.HasSuffix(p, "/busy")
	}, (*Server).apiToolBusy},
	{http.MethodDelete, func(p string) bool { return strings.HasPrefix(p, "/api/tools/") }, (*Server).apiToolDelete},
	{http.MethodGet, exactPath("/api/focus"), (*Server).apiFocusGet},
	{http.MethodPost, exactPath("/api/focus/claim"), (*Server).apiFocusClaim},
	{http.MethodGet, exactPath("/api/workspace"), (*Server).apiWorkspaceGet},
	{http.MethodPut, exactPath("/api/workspace"), (*Server).apiWorkspacePut},
	{http.MethodGet, exactPath("/api/settings"), (*Server).apiSettingsGet},
	{http.MethodPut, exactPath("/api/settings"), (*Server).apiSettingsPut},
	{http.MethodPost, exactPath("/api/upload"), (*Server).apiUpload},
	{http.MethodGet, exactPath("/api/download"), (*Server).apiDownload},
	{http.MethodGet, exactPath("/api/cwd"), (*Server).apiCwd},
	{http.MethodGet, exactPath("/api/file/read"), (*Server).apiFileRead},
	{http.MethodPost, exactPath("/api/file/write"), (*Server).apiFileWrite},
	{"", exactPath("/api/ping"), (*Server).apiPing},
	{http.MethodGet, exactPath("/api/stats"), (*Server).apiStats},
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
	if s.Tools == nil {
		http.Error(w, "tools unavailable", 500)
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
		"tools":     s.Tools.List(),
		"workspace": ws,
	})
}

func (s *Server) apiToolsCreate(w http.ResponseWriter, r *http.Request) {
	if s.Tools == nil {
		http.Error(w, "tools unavailable", 500)
		return
	}
	cols, rows := ParseSize(r)
	cwd := r.URL.Query().Get("cwd")
	if cwd == "" {
		if refID := r.URL.Query().Get("cwdTool"); refID != "" {
			cwd = s.Tools.Cwd(refID)
		}
	}
	tool, err := s.Tools.Create(cwd, cols, rows)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"id": tool.ID, "name": tool.Name})
}

func (s *Server) apiToolBusy(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/tools/"), "/busy")
	var busy bool
	if s.Tools != nil {
		busy = s.Tools.Busy(id)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"busy": busy})
}

// apiToolsAttention returns the ids of tools currently needing attention, so a
// late-joining / reconnecting client can restore highlights (FR-PAN-8).
func (s *Server) apiToolsAttention(w http.ResponseWriter, r *http.Request) {
	ids := []string{}
	if s.AttnTracker != nil {
		ids = s.AttnTracker.AttentionIDs()
	} else if al, ok := s.Tools.(interface{ AttentionIDs() []string }); ok {
		if got := al.AttentionIDs(); got != nil {
			ids = got
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"toolIds": ids})
}

// apiToolAttentionSet flags a tool as needing attention. Used by `dmctl notify`
// (agent hook bridge) which identifies its tool via DONGMINAL_TOOL_ID — this
// works from detached hooks that have no controlling terminal. Body:
// {"toolId":"...","reason":"done|waiting|..."}. Unknown tool is a 200 no-op;
// missing toolId is 400.
func (s *Server) apiToolAttentionSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ToolID string `json:"toolId"`
		Reason string `json:"reason"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ToolID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	reason := req.Reason
	if reason == "" {
		reason = "signaled"
	}
	if s.Tools != nil {
		if s.AttnTracker != nil {
			// Verify tool exists before flagging attention
			if s.Tools.Get(req.ToolID) != nil {
				s.AttnTracker.SignalAttention(req.ToolID, reason)
			}
		} else if tool := s.Tools.Get(req.ToolID); tool != nil {
			tool.signalAttention(reason)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// apiToolAttentionClear clears a tool's attention (and broadcasts the clear)
// when the user focuses/opens it. Body: {"toolId":"..."}. Unknown/idle tool is
// a no-op (200) so a stale focus event never errors.
func (s *Server) apiToolAttentionClear(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ToolID string `json:"toolId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ToolID == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if s.Tools != nil {
		if s.AttnTracker != nil {
			s.AttnTracker.Attend(req.ToolID)
		} else if tool := s.Tools.Get(req.ToolID); tool != nil {
			tool.attend()
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// apiToolsActivity returns the current activity snapshot of every tool that has
// reported one, so a late-joining / reconnecting client can restore cards
// (FR-AAP-4).
func (s *Server) apiToolsActivity(w http.ResponseWriter, r *http.Request) {
	acts := []activitySnap{}
	if s.AttnTracker != nil {
		acts = s.AttnTracker.ActivitySnapshot()
	} else if al, ok := s.Tools.(interface{ ActivitySnapshot() []activitySnap }); ok {
		if got := al.ActivitySnapshot(); got != nil {
			acts = got
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"activities": acts})
}

// apiToolActivitySet records what an agent in a tool is currently doing. Used by
// `dmctl activity` (agent hook bridge), identified via DONGMINAL_TOOL_ID. Body:
// {"toolId":"...","state":"working|done|waiting|idle","tool":"...","detail":"..."}.
// Unknown tool is a 200 no-op; missing toolId or invalid state is 400 (FR-AAP-3).
func (s *Server) apiToolActivitySet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ToolID string `json:"toolId"`
		State  string `json:"state"`
		Tool   string `json:"tool"`
		Detail string `json:"detail"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.ToolID == "" || !validActivityState(req.State) {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if s.Tools != nil {
		if s.AttnTracker != nil {
			s.AttnTracker.SetActivity(req.ToolID, req.State,
				sanitizeActivityField(req.Tool, activityToolMax),
				sanitizeActivityField(req.Detail, activityDetailMax))
		} else if tool := s.Tools.Get(req.ToolID); tool != nil {
			tool.setActivity(req.State, sanitizeActivityField(req.Tool, activityToolMax), sanitizeActivityField(req.Detail, activityDetailMax))
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

// apiToolAttentionClearAll dismisses every tool's attention at once (FR-PAN-17).
func (s *Server) apiToolAttentionClearAll(w http.ResponseWriter, r *http.Request) {
	cleared := 0
	if s.AttnTracker != nil {
		cleared = s.AttnTracker.ClearAllAttention()
	} else if ca, ok := s.Tools.(interface{ ClearAllAttention() int }); ok {
		cleared = ca.ClearAllAttention()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"cleared": cleared})
}

func (s *Server) apiToolDelete(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/tools/")
	if s.Tools != nil {
		s.Tools.Delete(id)
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
	safeDir, err := safeResolve("/", dir)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	outPath := uniquePath(safeDir, header.Filename)
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
	if _, err := safeResolve("/", fp); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
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
	toolID := r.URL.Query().Get("tool")
	var cwd string
	if toolID != "" && s.Tools != nil {
		cwd = s.Tools.Cwd(toolID)
	}
	if cwd == "" {
		cwd, _ = os.Getwd()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"cwd": cwd})
}

func (s *Server) apiFileRead(w http.ResponseWriter, r *http.Request) {
	fp := r.URL.Query().Get("path")
	if fp == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(fp) {
		http.Error(w, "path must be absolute", http.StatusBadRequest)
		return
	}
	if _, err := safeResolve("/", fp); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
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
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.Copy(w, f)
}

type fileWriteReq struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (s *Server) apiFileWrite(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "read body: "+err.Error(), http.StatusBadRequest)
		return
	}
	var req fileWriteReq
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid json: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Path == "" {
		http.Error(w, "missing path", http.StatusBadRequest)
		return
	}
	if !filepath.IsAbs(req.Path) {
		http.Error(w, "path must be absolute", http.StatusBadRequest)
		return
	}
	if _, err := safeResolve("/", req.Path); err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if err := os.WriteFile(req.Path, []byte(req.Content), 0o644); err != nil {
		log.Printf("file write error: %v", err)
		http.Error(w, "write failed: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func (s *Server) apiPing(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("ok"))
}

func (s *Server) apiStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.getStats())
}

// apiToolsBackground lists the tools currently sent to the background,
// oldest transition first (FR-BG-6).
func (s *Server) apiToolsBackground(w http.ResponseWriter, r *http.Request) {
	list := []BackgroundEntry{}
	if s.Tools != nil {
		if got := s.Tools.BackgroundList(); got != nil {
			list = got
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"background": list})
}

// apiToolBackgroundSet detaches a tool from its tab or restores it.
// Body: {"toolId":"...","background":true|false} (FR-BG-2/4/7).
// An unknown tool is a 404 — the caller asked about something that is gone,
// and silently succeeding would hide a stale id.
func (s *Server) apiToolBackgroundSet(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID     string `json:"toolId"`
		Background bool   `json:"background"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ToolID == "" {
		http.Error(w, "toolId 필요", http.StatusBadRequest)
		return
	}
	if s.Tools == nil || !s.Tools.SetBackground(body.ToolID, body.Background) {
		http.Error(w, "toolId="+body.ToolID+" 존재하지 않음", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"ok": true})
}
