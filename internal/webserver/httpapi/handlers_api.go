package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/workspace"
)

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
	// 묶음 B·C — 리포 해석·핀·변경 감지 (GIT_SRS FR-GIT-60/61). UI 는 이 표면
	// 위에만 서고, git 실행 결과를 다른 경로로 얻지 않는다.
	// FR-GIT-223: 핀 순서는 서버가 권위로 쓴다 (O1) — 재배치도 서버를 지난다.
	// 묶음 F — diff 양쪽 내용 (GIT_SRS FR-GIT-44~48). commit-parent 축은 M4 다.
	// 묶음 J — 안전 정책 (GIT_SRS FR-GIT-86~93). 파괴적 경로가 열리는 시점과
	// 방어가 서는 시점이 같아야 한다.
	// 묶음 H·I — 스테이징·커밋 (GIT_SRS FR-GIT-64~85). 저장소를 바꾸는 표면이므로
	// POST 만 받고, 확인·preflight·undo 만료를 서버가 다시 검사한다.
	// FR-GIT-224: 충돌 파일을 한쪽으로 해결한다. 파괴적이라 discard 와 같은 규약이다.
	// 묶음 L·M — 히스토리 조회 (GIT_SRS FR-GIT-113·122·136~139). 전부 읽기다.
	// 묶음 Q — Console 탭의 실행 기록 (FR-GIT-218).
	// 묶음 K — 원격 작업 (GIT_SRS FR-GIT-98~112). fetch/pull/push 는 작업 식별자만
	// 돌려주고, 진행은 job/events 로 흐른다.
	// 준다 (FR-GIT-147) — 여기에 새 조회를 만들지 않는다.
	// 묶음 O — stash (GIT_SRS FR-GIT-161~170). drop 은 파괴적이므로 confirm 을
	// 서버가 다시 검사한다.
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
	if s.git != nil && s.git.Handle(w, r) {
		return
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
	cols, rows := toolhub.ParseSize(r)
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

func (s *Server) apiPing(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte("ok"))
}

func (s *Server) apiStats(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(s.getStats())
}
