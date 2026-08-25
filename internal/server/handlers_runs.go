// 묶음 R — Run 레코드의 서버 계층이다 (RUN_ORCHESTRATION_SRS §3.1).
//
// Run 은 공간 계층의 레벨이 아니라 직교 축이다. 여기 있는 것은 "무엇이 누구의
// 것인가"의 기록과 조회이며, **무엇을 언제 시킬지는 조정자 에이전트가 정한다**
// (DC-RUN-1). 서버는 스케줄러가 되지 않는다.
package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"dongminal/internal/run"
	"dongminal/internal/workspace"
	"dongminal/internal/worktree"
)

// runsReady guards every handler: a wiring without the store answers 503
// instead of dereferencing nil. Run 을 쓰지 않는 일상 사용에는 영향이 없다
// (NFR-RUN-1).
func (s *Server) runsReady(w http.ResponseWriter) bool {
	if s.Runs == nil {
		writeToolIOError(w, http.StatusServiceUnavailable, "run store unavailable")
		return false
	}
	return true
}

// memberView is a Member with its state derived at query time (FR-RUN-6).
type memberView struct {
	run.Member
	State run.MemberState `json:"state"`
	// Preamble 은 멤버 생성 응답에서만 채워진다 (FR-PRE-1). 목록·상태 조회에
	// 매번 실으면 응답이 멤버 수만큼 부풀고, 조회의 쓰임과도 무관하다.
	Preamble string `json:"preamble,omitempty"`
}

// runView is a Record whose members carry derived state.
type runView struct {
	run.Record
	Members []memberView `json:"members"`
}

// deriveMemberState resolves what a member is doing right now. A member that
// has reported is settled — the record wins over any later observation, because
// an agent idling at its prompt after reporting is still done.
func (s *Server) deriveMemberState(m run.Member) run.MemberState {
	switch m.State {
	case run.Done, run.Failed, run.Released:
		return m.State
	}
	if !s.toolLive(m.ToolID) {
		return run.Lost
	}
	switch s.toolStatusOf(m.ToolID, true).State {
	case "working":
		return run.Working
	case "waiting":
		return run.Waiting
	case "idle", "done":
		return run.Ready
	}
	return run.Starting
}

func (s *Server) viewOf(rec run.Record) runView {
	members := make([]memberView, 0, len(rec.Members))
	for _, m := range rec.Members {
		members = append(members, memberView{Member: m, State: s.deriveMemberState(m)})
	}
	return runView{Record: rec, Members: members}
}

// callerToolID decides who is speaking. The PID parent-chain resolution wins
// when it answers — it cannot be spoofed by the request body. The claimed id
// (DONGMINAL_TOOL_ID, injected by the server into the tool's shell) is the
// fallback for paths where the chain cannot resolve, e.g. daemon mode.
func (s *Server) callerToolID(r *http.Request, claimed string) string {
	if s.WhoAmI != nil {
		if id, _, err := s.WhoAmI.ResolveClientPane(r.RemoteAddr); err == nil && id != "" {
			return id
		}
	}
	return claimed
}

// writeRunError maps a store error to its HTTP status. Refusal reasons are
// enumerated, never lumped together (FR-PRE-6).
func writeRunError(w http.ResponseWriter, err error, extra map[string]any) {
	status := http.StatusInternalServerError
	name := err.Error()
	switch {
	case errors.Is(err, run.ErrUnknownRun):
		status, name = http.StatusNotFound, run.ErrUnknownRun.Error()
	case errors.Is(err, run.ErrSenderNotMember):
		status, name = http.StatusForbidden, run.ErrSenderNotMember.Error()
	case errors.Is(err, run.ErrUnknownMember):
		status, name = http.StatusNotFound, run.ErrUnknownMember.Error()
	case errors.Is(err, run.ErrRunMemberMismatch):
		status, name = http.StatusForbidden, run.ErrRunMemberMismatch.Error()
	case errors.Is(err, run.ErrRunClosed):
		status, name = http.StatusConflict, run.ErrRunClosed.Error()
	case errors.Is(err, run.ErrAlreadyReported):
		status, name = http.StatusConflict, run.ErrAlreadyReported.Error()
	case errors.Is(err, run.ErrToolAlreadyMember):
		status, name = http.StatusConflict, run.ErrToolAlreadyMember.Error()
	case errors.Is(err, run.ErrUnreportedMembers):
		status, name = http.StatusConflict, run.ErrUnreportedMembers.Error()
	case errors.Is(err, run.ErrInvalidArgument):
		status, name = http.StatusBadRequest, run.ErrInvalidArgument.Error()
	// 격리 실패는 사유를 뭉뚱그리지 않는다 (FR-WKT-11) — 조정자가 "저장소가
	// 아니다"와 "인자가 위험하다"에 다르게 대응해야 한다.
	case errors.Is(err, worktree.ErrNotRepo):
		status, name = http.StatusBadRequest, worktree.ErrNotRepo.Error()
	case errors.Is(err, worktree.ErrGitMissing):
		status, name = http.StatusBadRequest, worktree.ErrGitMissing.Error()
	case errors.Is(err, worktree.ErrUnsafeArgument):
		status, name = http.StatusBadRequest, worktree.ErrUnsafeArgument.Error()
	case errors.Is(err, worktree.ErrUnsafePath):
		status, name = http.StatusBadRequest, worktree.ErrUnsafePath.Error()
	case errors.Is(err, errIsolationUnavailable):
		status, name = http.StatusServiceUnavailable, errIsolationUnavailable.Error()
	}
	body := map[string]any{"error": name, "detail": err.Error()}
	for k, v := range extra {
		body[k] = v
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// apiRunsGet implements GET /api/runs[?id=] (FR-RUN-8).
func (s *Server) apiRunsGet(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	if id := r.URL.Query().Get("id"); id != "" {
		rec, ok := s.Runs.Get(id)
		if !ok {
			writeRunError(w, run.ErrUnknownRun, nil)
			return
		}
		writeJSON(w, s.viewOf(rec))
		return
	}
	recs := s.Runs.List()
	views := make([]runView, 0, len(recs))
	for _, rec := range recs {
		views = append(views, s.viewOf(rec))
	}
	writeJSON(w, map[string]any{"runs": views})
}

// apiRunStart implements POST /api/runs (FR-RUN-1).
func (s *Server) apiRunStart(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	var body struct {
		Objective  string `json:"objective"`
		Projection string `json:"projection"`
		Isolation  string `json:"isolation"`
		WindowID   string `json:"windowId"`
		ToolID     string `json:"toolId"`
		// Cwd 는 조정자의 작업 디렉터리다. 격리 Run 의 저장소·base 가 여기서
		// 나온다 (FR-WKT-5) — 서버의 cwd 가 아니라 **조정자의** cwd 여야 하므로
		// dmctl 이 실어 보낸다.
		Cwd  string `json:"cwd"`
		Base string `json:"base"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeToolIOError(w, http.StatusBadRequest, "잘못된 JSON: "+err.Error())
		return
	}
	if body.Isolation == "" {
		body.Isolation = string(run.IsolationNone)
	}
	iso := run.Isolation(body.Isolation)
	if !iso.Valid() {
		writeRunError(w, fmt.Errorf("%w: 알 수 없는 isolation: %q", run.ErrInvalidArgument, iso), nil)
		return
	}
	// 격리 준비가 **레코드보다 먼저**다 (FR-WKT-3/11). 비git 디렉터리·git 부재는
	// 여기서 명확히 실패하고, 실패한 Run 은 기록에 남지 않는다.
	prov, err := s.provisionRun(iso, body.Cwd, body.Base)
	if err != nil {
		writeRunError(w, err, nil)
		return
	}
	opts := run.StartOptions{
		Objective:         body.Objective,
		Projection:        run.Projection(body.Projection),
		Isolation:         iso,
		CoordinatorToolID: s.callerToolID(r, body.ToolID),
		WindowID:          body.WindowID,
	}
	if prov != nil {
		opts.ID, opts.Repo, opts.Base, opts.Worktree = prov.ID, prov.Repo, prov.Base, prov.Worktree
	}
	rec, err := s.Runs.Start(opts)
	if err != nil {
		s.rollbackRun(prov)
		writeRunError(w, err, nil)
		return
	}
	log.Printf("[run] start id=%s short=%s projection=%s isolation=%s coordinator=%s",
		rec.ID, rec.Short, rec.Projection, rec.Isolation, rec.CoordinatorToolID)
	writeJSON(w, s.viewOf(rec))
}

// apiRunMemberAdd implements POST /api/runs/members (FR-RUN-2).
//
// 도구는 uuid·toolId·라벨 어느 형식으로도 지목할 수 있고, 탭 uuid 는 서버가
// 채운다 — 조정자가 이후 생성·정리 명령에서 `location` 으로 쓸 값이다 (FR-RUN-9).
func (s *Server) apiRunMemberAdd(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) || !s.toolIOReady(w) {
		return
	}
	var body struct {
		RunID string `json:"runId"`
		Role  string `json:"role"`
		Agent string `json:"agent"`
		Brief string `json:"brief"`
		ID    string `json:"id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeToolIOError(w, http.StatusBadRequest, "잘못된 JSON: "+err.Error())
		return
	}
	toolID, ok := s.resolveToolID(w, body.ID)
	if !ok {
		return
	}
	rec, known := s.Runs.Get(body.RunID)
	if !known {
		writeRunError(w, run.ErrUnknownRun, nil)
		return
	}
	// 작업 트리를 멤버 등록보다 먼저 만든다 — 등록이 거부되면 되돌릴 수 있지만,
	// 반대 순서로는 트리 없는 멤버가 기록에 남는다 (FR-WKT-3).
	mi, err := s.provisionMember(rec, body.Role)
	if err != nil {
		writeRunError(w, err, nil)
		return
	}
	m, err := s.Runs.AddMember(body.RunID, run.MemberSpec{
		ID:       mi.ID,
		Role:     body.Role,
		Agent:    body.Agent,
		Brief:    body.Brief,
		ToolID:   toolID,
		TabID:    s.tabIDOfTool(toolID),
		Worktree: mi.Worktree,
	})
	if err != nil {
		s.rollbackMember(mi)
		writeRunError(w, err, nil)
		return
	}
	view := memberView{Member: m, State: s.deriveMemberState(m)}
	if rec, ok := s.Runs.Get(body.RunID); ok {
		s.markWorkspaceRun(rec, m.TabID, rec.ID)
		// 프리앰블을 응답에 실어 보낸다 — 조정자가 uuid 를 손으로 옮겨 적을 일이
		// 없어야 그 계열의 결함이 사라진다 (FR-PRE-1).
		view.Preamble = run.Preamble(rec, m)
	}
	log.Printf("[run] member run=%s member=%s role=%s agent=%s tool=%s tab=%s",
		body.RunID, m.ID, m.Role, m.Agent, m.ToolID, m.TabID)
	writeJSON(w, view)
}

// apiRunPreamble implements GET /api/runs/preamble?member= (FR-PRE-1).
//
// 별도 조회 경로를 두는 이유는 프리앰블이 **재조회 가능해야** 하기 때문이다 —
// 붙여넣기가 실패했거나 조정자가 컨텍스트를 잃었을 때, 기록에서 같은 텍스트를
// 다시 만들 수 있어야 한다. 재조립이 결정적인 근거는 brief 를 Member 에
// 영속하는 것이다.
func (s *Server) apiRunPreamble(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	memberID := r.URL.Query().Get("member")
	rec, m, ok := s.Runs.FindMember(memberID)
	if !ok {
		// sender_not_member 를 쓰지 않는다 — 그것은 보고 **권한**의 사유이고,
		// 여기서 실패한 것은 조회다. 뭉뚱그리면 조정자가 권한 문제로 오진한다.
		writeRunError(w, run.ErrUnknownMember, map[string]any{"memberId": memberID})
		return
	}
	writeJSON(w, map[string]any{
		"runId": rec.ID, "memberId": m.ID, "role": m.Role, "agent": m.Agent,
		"tabId": m.TabID, "toolId": m.ToolID, "runState": rec.State,
		"preamble": run.Preamble(rec, m),
	})
}

// apiRunReport implements POST /api/runs/report (FR-PRE-2/5/7).
func (s *Server) apiRunReport(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	var body struct {
		RunID    string   `json:"runId"`
		MemberID string   `json:"memberId"`
		ToolID   string   `json:"toolId"`
		Outcome  string   `json:"outcome"`
		Summary  string   `json:"summary"`
		Files    []string `json:"files"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeToolIOError(w, http.StatusBadRequest, "잘못된 JSON: "+err.Error())
		return
	}
	sender := s.callerToolID(r, body.ToolID)
	m, err := s.Runs.Report(sender, run.ReportSpec{
		RunID:         body.RunID,
		MemberID:      body.MemberID,
		Outcome:       run.Outcome(body.Outcome),
		Summary:       body.Summary,
		FilesModified: body.Files,
	})
	if err != nil {
		writeRunError(w, err, nil)
		return
	}
	log.Printf("[run] report run=%s member=%s tool=%s outcome=%s files=%d",
		m.RunID, m.ID, m.ToolID, m.Outcome, len(m.FilesModified))
	writeJSON(w, memberView{Member: m, State: m.State})
}

// apiRunClose implements POST /api/runs/close (FR-RUN-10/11).
//
// **도구를 여기서 닫지 않는다.** 실행 중인 도구의 탭을 닫으면 브라우저가 확인창을
// 띄우므로(FR-BG-3) 무인 정리가 그 자리에서 막힌다. 대신 정리 대상을 돌려주고,
// 조정자가 에이전트의 종료 명령 → `close-tab` 순으로 처리한다. §6 의 개정 참조.
func (s *Server) apiRunClose(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	var body struct {
		RunID string `json:"runId"`
		Force bool   `json:"force"`
		// KeepWorktrees 는 전부 보존한다 (FR-WKT-8). 보존도 **보고**된다 —
		// 조용히 남는 자원이 없어야 한다 (FR-WKT-12).
		KeepWorktrees bool `json:"keepWorktrees"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeToolIOError(w, http.StatusBadRequest, "잘못된 JSON: "+err.Error())
		return
	}
	rec, pending, err := s.Runs.Close(body.RunID, body.Force)
	if err != nil {
		extra := map[string]any(nil)
		if len(pending) > 0 {
			items := make([]memberView, 0, len(pending))
			for _, m := range pending {
				items = append(items, memberView{Member: m, State: s.deriveMemberState(m)})
			}
			extra = map[string]any{"unreported": items}
		}
		writeRunError(w, err, extra)
		return
	}
	s.markWorkspaceRun(rec, "", "") // 표식 해제
	cleanup := make([]map[string]any, 0, len(rec.Members))
	for _, m := range rec.Members {
		cleanup = append(cleanup, map[string]any{
			"memberId": m.ID, "role": m.Role, "toolId": m.ToolID,
			"tabId": m.TabID, "agent": m.Agent, "live": s.toolLive(m.ToolID),
		})
	}
	trees := s.cleanupWorktrees(rec, body.KeepWorktrees)
	residue := 0
	for _, t := range trees {
		if !t.Removed {
			residue++
		}
	}
	log.Printf("[run] close id=%s members=%d force=%v worktrees=%d residue=%d",
		rec.ID, len(rec.Members), body.Force, len(trees), residue)
	writeJSON(w, map[string]any{
		"id": rec.ID, "short": rec.Short, "state": rec.State,
		"closedAt": rec.ClosedAt, "windowId": rec.WindowID, "cleanup": cleanup,
		"worktrees": trees, "residue": residue,
	})
}

// tabIDOfTool finds the tab uuid that hosts a tool. Empty when the tool is not
// referenced by any tab (a background tool, for instance).
func (s *Server) tabIDOfTool(toolID string) string {
	if s.WorkIndex == nil {
		return ""
	}
	for _, e := range s.WorkIndex.Entries() {
		if e.ToolID == toolID {
			return e.TabUUID
		}
	}
	return ""
}

// markWorkspaceRun writes (or clears) the FR-EM-17 junction fields:
// `tab.runId` for tabID, and `window.ownerRunId` for a dedicated-window Run.
// runID == "" clears both for every member tab of rec.
//
// **Best-effort by design.** workspace.json 의 쓰기 주체는 브라우저이고, 그쪽의
// 409 처리는 머지 없이 재PUT 이다 (WORKSPACE_IDENTITY_SRS §2.4) — 동시 편집이
// 겹치면 이 표식이 지워질 수 있다. 표식은 UI·관측용 보조이며 소유권의 진실은
// runs.json 이다 (FR-RUN-10). 그래서 실패는 로그 한 줄로 끝내고 요청을 깨뜨리지
// 않는다 (NFR-RUN-3).
func (s *Server) markWorkspaceRun(rec run.Record, tabID, runID string) {
	if s.Work == nil {
		return
	}
	tabs := map[string]bool{}
	if tabID != "" {
		tabs[tabID] = true
	} else {
		for _, m := range rec.Members {
			if m.TabID != "" {
				tabs[m.TabID] = true
			}
		}
	}
	markWindow := rec.Projection == run.DedicatedWindow && rec.WindowID != ""

	for attempt := 0; attempt < 3; attempt++ {
		blob, rev := s.Work.Snapshot()
		if len(blob) == 0 {
			return
		}
		var tree map[string]any
		if err := json.Unmarshal(blob, &tree); err != nil {
			log.Printf("[run] workspace 표식 생략 — 파싱 실패: %v", err)
			return
		}
		if !applyRunMarks(tree, tabs, rec.WindowID, markWindow, runID) {
			return // 바꿀 것이 없다
		}
		out, err := json.Marshal(tree)
		if err != nil {
			log.Printf("[run] workspace 표식 생략 — 직렬화 실패: %v", err)
			return
		}
		newRev, err := s.Work.Save(out, strconv.FormatUint(rev, 10))
		if err == nil {
			if s.Commands != nil {
				payload, _ := json.Marshal(map[string]any{
					"action": "workspace_changed",
					"args":   map[string]any{"rev": newRev},
				})
				s.Commands.Broadcast(payload)
			}
			return
		}
		if !errors.Is(err, workspace.ErrStale) {
			log.Printf("[run] workspace 표식 실패: %v", err)
			return
		}
	}
	log.Printf("[run] workspace 표식 포기 — 동시 편집으로 3회 stale (runId=%s)", runID)
}

// applyRunMarks mutates the decoded workspace tree in place. It walks generic
// maps rather than typed structs so fields this server does not know about —
// everything the browser writes — survive the round trip. Reports whether
// anything changed.
func applyRunMarks(tree map[string]any, tabs map[string]bool, windowID string, markWindow bool, runID string) bool {
	wins, _ := tree["windows"].([]any)
	changed := false
	for _, wv := range wins {
		win, _ := wv.(map[string]any)
		if win == nil {
			continue
		}
		if markWindow {
			if id, _ := win["id"].(string); id == windowID {
				changed = setOrClear(win, "ownerRunId", runID) || changed
			}
		} else if runID == "" && windowID != "" {
			if id, _ := win["id"].(string); id == windowID {
				changed = setOrClear(win, "ownerRunId", "") || changed
			}
		}
		if markTabsIn(win["layout"], tabs, runID) {
			changed = true
		}
	}
	return changed
}

// markTabsIn walks a layout node (pane or split) and marks matching tabs.
func markTabsIn(node any, tabs map[string]bool, runID string) bool {
	n, _ := node.(map[string]any)
	if n == nil {
		return false
	}
	changed := false
	if list, ok := n["tabs"].([]any); ok {
		for _, tv := range list {
			tab, _ := tv.(map[string]any)
			if tab == nil {
				continue
			}
			if id, _ := tab["id"].(string); tabs[id] {
				changed = setOrClear(tab, "runId", runID) || changed
			}
		}
	}
	if kids, ok := n["children"].([]any); ok {
		for _, kid := range kids {
			if markTabsIn(kid, tabs, runID) {
				changed = true
			}
		}
	}
	return changed
}

// setOrClear writes value or removes the key when value is empty. Reports
// whether the map changed — an unchanged tree must not cost a workspace save.
func setOrClear(m map[string]any, key, value string) bool {
	if value == "" {
		if _, ok := m[key]; !ok {
			return false
		}
		delete(m, key)
		return true
	}
	if cur, _ := m[key].(string); cur == value {
		return false
	}
	m[key] = value
	return true
}
