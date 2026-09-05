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

	"dongminal/internal/shared/sandbox"
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
	// ── ORCHESTRATION_V2 · CONVENIENCE ──
	//
	// 순서 주의: 매칭은 **첫 성공이 이긴다**(§dispatch). 아래 exactPath 들이
	// /api/runs/{id}/graph 의 prefix 매칭보다 먼저 와야 한다.
	{http.MethodGet, exactPath("/api/runs/peers"), (*Server).apiRunPeers},      // 묶음 P (WS-4)
	{http.MethodPost, exactPath("/api/runs/attach"), (*Server).apiRunAttach},   // 묶음 H (WS-2)
	{http.MethodPost, exactPath("/api/runs/detach"), (*Server).apiRunDetach},   // 묶음 H (WS-2)
	{http.MethodPost, exactPath("/api/runs/succeed"), (*Server).apiRunSucceed}, // 묶음 C (WS-3)
	{http.MethodPost, exactPath("/api/runs/handoff"), (*Server).apiRunHandoff}, // 묶음 C (WS-3)
	// 관측 수신 종단. activity/set(= WS-2 파일)에 필드를 붙이는 대신 전용 경로를
	// 둔다 — 라우트 1줄이 남의 핸들러 본문 수정보다 싸고, 컨텍스트 관측은
	// activity(무엇을 하는가)와 직교하는 별개 레이어다.
	{http.MethodPost, exactPath("/api/runs/context"), (*Server).apiRunContext},      // 묶음 C (WS-3)
	{http.MethodPost, exactPath("/api/tools/headless"), (*Server).apiToolsHeadless}, // 묶음 H (WS-2)
	{http.MethodPost, exactPath("/api/tools/kill"), (*Server).apiToolKill},          // 묶음 X (WS-8)
	{http.MethodGet, func(p string) bool {
		return strings.HasPrefix(p, "/api/runs/") && strings.HasSuffix(p, "/graph")
	}, (*Server).apiRunGraph}, // 묶음 V (WS-5)
	// UX_REVISION_SRS FR-DEL-5: Run 레코드 삭제. exactPath 가 아닌 이유는 id 가
	// 경로에 오기 때문이며, /api/tools/ 의 DELETE 와 같은 모양이다.
	{http.MethodDelete, func(p string) bool { return strings.HasPrefix(p, "/api/runs/") }, (*Server).apiRunDelete},
	{http.MethodGet, func(p string) bool {
		return strings.HasPrefix(p, "/api/tools/") && strings.HasSuffix(p, "/busy")
	}, (*Server).apiToolBusy},
	{http.MethodDelete, func(p string) bool { return strings.HasPrefix(p, "/api/tools/") }, (*Server).apiToolDelete},
	{http.MethodGet, exactPath("/api/focus"), (*Server).apiFocusGet},
	{http.MethodPost, exactPath("/api/focus/claim"), (*Server).apiFocusClaim},
	{http.MethodGet, exactPath("/api/sandbox/profiles"), (*Server).apiSandboxProfiles},
	{http.MethodGet, exactPath("/api/sandbox/config"), (*Server).apiSandboxConfigGet},
	{http.MethodPut, exactPath("/api/sandbox/config"), (*Server).apiSandboxConfigPut},
	{http.MethodGet, exactPath("/api/workspace"), (*Server).apiWorkspaceGet},
	{http.MethodPut, exactPath("/api/workspace"), (*Server).apiWorkspacePut},
	{http.MethodGet, exactPath("/api/settings"), (*Server).apiSettingsGet},
	{http.MethodPut, exactPath("/api/settings"), (*Server).apiSettingsPut},
	{http.MethodPost, exactPath("/api/upload"), (*Server).apiUpload},
	{http.MethodGet, exactPath("/api/download"), (*Server).apiDownload},
	{http.MethodGet, exactPath("/api/cwd"), (*Server).apiCwd},
	{http.MethodGet, exactPath("/api/file/read"), (*Server).apiFileRead},
	{http.MethodPost, exactPath("/api/file/write"), (*Server).apiFileWrite},
	// EDITOR_GIT_UX_SRS 묶음 V — 열 수 있는 형식인가, 그리고 이미지 바이트.
	{http.MethodGet, exactPath("/api/file/probe"), (*Server).apiFileProbe},
	{http.MethodGet, exactPath("/api/file/raw"), (*Server).apiFileRaw},
	// 묶음 S — 탐색기의 디렉터리 조회·파일 조작과 Editor 목록
	// (EDITOR_TAB_SRS FR-EDT-108~110). /api/file/* 과 달리 전부 root 를 함께 받아
	// 그 아래로 제한한다 (D-16) — 조작은 트리에서 파생된 경로를 지운다.
	{http.MethodGet, exactPath("/api/fs/list"), (*Server).apiFSList},
	// NOTES_LIVE_EXPLORER_SRS 묶음 L — 겹이 바뀌었는지만 묻는다. list 옆에 두는
	// 이유는 같은 것(겹)을 보는 두 물음이기 때문이다: 이쪽이 "바뀌었나", 저쪽이
	// "무엇이 있나" 다.
	{http.MethodPost, exactPath("/api/fs/stamp"), (*Server).apiFSStamp},
	// EDITOR_GIT_UX_SRS 묶음 F·G — Editor 창의 파일 이름 찾기·전체 내용 찾기.
	{http.MethodGet, exactPath("/api/fs/find"), (*Server).apiFSFind},
	{http.MethodGet, exactPath("/api/fs/grep"), (*Server).apiFSGrep},
	// EXPLORER_TRANSFER_IGNORE_SRS 묶음 A — 한 겹에서 무시된 이름을 가른다.
	// status 폴링에 얹지 않는 이유는 D-1 이다.
	{http.MethodPost, exactPath("/api/fs/ignored"), (*Server).apiFSIgnored},
	{http.MethodPost, exactPath("/api/fs/create"), (*Server).apiFSCreate},
	{http.MethodPost, exactPath("/api/fs/rename"), (*Server).apiFSRename},
	{http.MethodPost, exactPath("/api/fs/delete"), (*Server).apiFSDelete},
	// FR-WBR-60: 탐색기의 복사·복제. 루트를 **둘** 받는 유일한 fs 종단이다.
	{http.MethodPost, exactPath("/api/fs/copy"), (*Server).apiFSCopy},
	// 묶음 D·E — 탐색기의 전송 (FILE_TRANSFER_SRS FR-FTR-12·15). 터미널의
	// /api/{upload,download} 와 같은 일을 하되 root 가드를 받는다.
	{http.MethodGet, exactPath("/api/fs/download"), (*Server).apiFSDownload},
	// EXPLORER_TRANSFER_IGNORE_SRS 묶음 B — 폴더를 zip 으로. 파일 종단과 나눈
	// 이유는 FR-ETR-11 이다 — 두 종단이 서로의 일을 대신하지 않는다.
	{http.MethodGet, exactPath("/api/fs/download-dir"), (*Server).apiFSDownloadDir},
	{http.MethodPost, exactPath("/api/fs/upload"), (*Server).apiFSUpload},
	// EDITOR_LSP_SRS 묶음 A — 언어 서버의 관측과 설치. 둘 다 POST 인 것은 본문이
	// 필요하기 때문이다 (FR-LSP-4b: 절대경로 표가 요청에 실린다) — `/api/fs/stamp`
	// 와 같은 이유다.
	{http.MethodPost, exactPath("/api/lsp/status"), (*Server).apiLSPStatus},
	{http.MethodPost, exactPath("/api/lsp/install"), (*Server).apiLSPInstall},
	// 정의·참조는 `fsRoot` 가드를 딛는다 (FR-LSP-24·49) — /api/fs/* 와 같은 가드다.
	{http.MethodPost, exactPath("/api/lsp/definition"), (*Server).apiLSPDefinition},
	{http.MethodPost, exactPath("/api/lsp/references"), (*Server).apiLSPReferences},
	{http.MethodPost, exactPath("/api/lsp/hover"), (*Server).apiLSPHover},
	{http.MethodGet, exactPath("/api/editors"), (*Server).apiEditorsGet},
	{http.MethodPost, exactPath("/api/editors/add"), (*Server).apiEditorsAdd},
	{http.MethodPost, exactPath("/api/editors/remove"), (*Server).apiEditorsRemove},
	{http.MethodPost, exactPath("/api/editors/reorder"), (*Server).apiEditorsReorder},
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
	tools, known := listTools(s.Tools)
	w.Header().Set("ETag", strconv.FormatUint(rev, 10))
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"tools": tools,
		// TOOL_LIST_UNKNOWN_SRS FR-TLU-1: 목록과 함께 **그것을 믿어도 되는가**를
		// 보낸다. 이 답이 없으면 받는 쪽은 빈 목록을 "도구가 하나도 없다"로 읽고
		// 살아 있는 도구를 전부 파괴한다 (SRS §2.2).
		"toolsKnown": known,
		"workspace":  ws,
	})
}

// listTools 는 도구 목록과 그것이 **관측된 사실인지**를 함께 준다.
//
// 데몬 모드의 ToolClient 만 모를 수 있다 — 목록이 다른 프로세스에 있기 때문이다.
// 그 사정을 아는 것은 ToolClient 자신이므로 판정도 그쪽에 있고(`ListOK`), 여기서는
// 타입 단언으로 물어본다. `handlers_ws.go` 가 `Connected()` 를 묻는 것과 같은
// 규약이다. 답할 수 없는 구현은 직접 모드이며 언제나 아는 것이다 (FR-TLU-3).
func listTools(h toolhub.ToolHub) ([]map[string]interface{}, bool) {
	if lk, ok := h.(interface {
		ListOK() ([]map[string]interface{}, bool)
	}); ok {
		return lk.ListOK()
	}
	return h.List(), true
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
	// FR-SBX-11: 어느 Window 의 어떤 프로파일인지는 호출자가 실어 보낸다.
	// 프로파일이 비어 있으면 종전대로 호스트에서 뜬다.
	tool, err := s.Tools.Create(cwd, cols, rows, toolhub.Placement{
		WindowUUID: r.URL.Query().Get("window"),
		Profile:    r.URL.Query().Get("sandbox"),
	})
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
	// FR-ATL-5: 데몬 모드에서 이미 죽어 있던 도구를 지우는 경로에는 OnExit 가
	// 오지 않는다. 직접 모드는 Delete → kill() 이 이미 해제하므로 여기는 no-op 다.
	if s.AttnTracker != nil {
		s.AttnTracker.Forget(id)
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
	// FR-SBX-8/9: Window 가 사라지면 그 대응 컨테이너도 사라져야 한다. 저장
	// 직후가 그것을 알 수 있는 자리다 — 브라우저가 어떤 경로로 창을 닫았든
	// (크래시 포함) 결국 여기를 지난다.
	s.reapSandboxes()

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

// reapSandboxes 는 살아 있는 Window 목록으로 대응 컨테이너를 회수한다.
//
// workspace 를 읽지 못하면 **아무것도 하지 않는다.** Windows() 의 nil 은 "창이
// 없다" 가 아니라 "판단 근거가 없다" 이며, 그것을 빈 목록으로 넘기면 파일 하나가
// 깨졌을 때 사용자의 컨테이너를 전부 지운다 (FR-SBX-9).
func (s *Server) reapSandboxes() {
	if s.Sandbox == nil || s.Work == nil {
		return
	}
	ws := s.Work.Windows()
	if ws == nil {
		return
	}
	live := make([]string, 0, len(ws))
	for _, w := range ws {
		live = append(live, w.UUID)
	}
	s.Sandbox.Reap(live)
}

// apiSandboxProfiles 는 쓸 수 있는 샌드박스 프로파일을 낸다 (FR-SBX-25).
//
// 컨테이너 런타임이 없으면 **빈 목록**이다 — 오류가 아니다. 화면은 그 경우
// 고를 것이 없다는 사실만 알면 된다 (NFR-SBX-3).
func (s *Server) apiSandboxProfiles(w http.ResponseWriter, r *http.Request) {
	list := []sandbox.ProfileInfo{}
	if s.Sandbox != nil {
		list = s.Sandbox.Profiles()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(list)
}

// apiSandboxConfigGet 은 지금 저장된 샌드박스 정의를 낸다 (FR-SBX-43).
func (s *Server) apiSandboxConfigGet(w http.ResponseWriter, r *http.Request) {
	if s.Sandbox == nil {
		http.Error(w, "샌드박스를 쓸 수 없습니다 — 컨테이너 런타임(docker)을 확인하세요", 503)
		return
	}
	cfg, err := s.Sandbox.Config()
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cfg)
}

// apiSandboxConfigPut 은 정의를 저장한다.
//
// 검증은 저장 쪽이 한다 — 화면이 보낸 것과 파일에서 읽은 것이 같은 문을 지나야
// 규칙이 갈리지 않는다. 400 으로 돌려주는 사유가 그대로 사용자에게 보인다.
func (s *Server) apiSandboxConfigPut(w http.ResponseWriter, r *http.Request) {
	if s.Sandbox == nil {
		http.Error(w, "샌드박스를 쓸 수 없습니다 — 컨테이너 런타임(docker)을 확인하세요", 503)
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := s.Sandbox.SaveConfig(body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	w.WriteHeader(204)
}
