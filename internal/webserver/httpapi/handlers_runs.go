// 묶음 R — Run 레코드의 서버 계층이다 (RUN_ORCHESTRATION_SRS §3.1).
//
// Run 은 공간 계층의 레벨이 아니라 직교 축이다. 여기 있는 것은 "무엇이 누구의
// 것인가"의 기록과 조회이며, **무엇을 언제 시킬지는 조정자 에이전트가 정한다**
// (DC-RUN-1). 서버는 스케줄러가 되지 않는다.
package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"

	"dongminal/internal/shared/workspace"
	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/domain/worktree"
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
	// Orphans 는 끝난 Run 에 남은 살아있는 헤드리스 도구다 (FR-HLM-5). 열린
	// Run 에서는 비며, 그때는 아무것도 실리지 않는다 — 남은 것이 없을 때 조용한
	// 것이 목록을 목록답게 만든다.
	Orphans []map[string]any `json:"orphans,omitempty"`
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
	return runView{Record: rec, Members: members, Orphans: s.orphanHeadless(rec)}
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
	case errors.Is(err, run.ErrRunOpen):
		status, name = http.StatusConflict, run.ErrRunOpen.Error()
	case errors.Is(err, run.ErrAlreadyReported):
		status, name = http.StatusConflict, run.ErrAlreadyReported.Error()
	case errors.Is(err, run.ErrToolAlreadyMember):
		status, name = http.StatusConflict, run.ErrToolAlreadyMember.Error()
	// 묶음 H — 부착·분리의 거부 (FR-HLM-6/7). 409 인 이유는 요청이 잘못된 것이
	// 아니라 멤버가 이미 그 상태이기 때문이다.
	case errors.Is(err, run.ErrMemberAttached):
		status, name = http.StatusConflict, run.ErrMemberAttached.Error()
	case errors.Is(err, run.ErrMemberNotAttached):
		status, name = http.StatusConflict, run.ErrMemberNotAttached.Error()
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
// 도구는 **탭 uuid 또는 살아있는 toolId** 로 지목한다. 좌표 라벨은 400 이다
// (FR-IDU-4) — 이 핸들러도 resolveToolID 를 지나므로 자동으로 그렇게 된다.
// 탭 uuid 는 서버가 채운다 — 조정자가 이후 생성·정리 명령에서 `location` 으로
// 쓸 값이다 (FR-RUN-9).
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
		// Headless 는 --at 의 배타적 대안이다 (FR-HLM-1). 참이면 서버가 Tool 을
		// 새로 만든다 — 지목할 탭이 없기 때문이다.
		Headless bool `json:"headless"`
		// Cwd 는 조정자의 작업 디렉터리다. 헤드리스 멤버의 cwd 는 **서버가
		// 확정한다** (FR-HLM-2) — 격리 Run 이면 멤버의 worktree, 아니면 이 값이다.
		// 헤드리스 멤버에게는 cd 를 대신 쳐 줄 사람이 없다.
		Cwd string `json:"cwd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeToolIOError(w, http.StatusBadRequest, "잘못된 JSON: "+err.Error())
		return
	}
	// FR-HLM-1: 정확히 하나여야 한다. 서버도 같은 검사를 하는 이유는 dmctl 만이
	// 이 종단의 호출자가 아니기 때문이다.
	if body.Headless == (body.ID != "") {
		writeRunError(w, fmt.Errorf(
			"%w: --at <탭 uuid> 와 --headless 중 정확히 하나가 필요하다", run.ErrInvalidArgument), nil)
		return
	}
	toolID := ""
	if !body.Headless {
		var ok bool
		if toolID, ok = s.resolveToolID(w, body.ID); !ok {
			return
		}
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
	if body.Headless {
		cwd := body.Cwd
		if mi.Worktree != nil && mi.Worktree.Path != "" {
			cwd = mi.Worktree.Path
		}
		if toolID, err = s.createHeadlessTool(cwd); err != nil {
			s.rollbackMember(mi)
			writeToolIOError(w, http.StatusInternalServerError, "헤드리스 도구 생성 실패: "+err.Error())
			return
		}
	}
	m, err := s.Runs.AddMember(body.RunID, run.MemberSpec{
		ID:       mi.ID,
		Role:     body.Role,
		Agent:    body.Agent,
		Brief:    body.Brief,
		ToolID:   toolID,
		TabID:    s.tabIDOfTool(toolID),
		Worktree: mi.Worktree,
		Headless: body.Headless,
	})
	if err != nil {
		// 보상 삭제 — 도구를 만들고 멤버 등록에 실패하면 그 도구는 누구의 것도
		// 아니다. FR-HLM-5 가 말하는 고아(Run 이 끝난 뒤 남은 도구)와는 다른
		// 것이며, 이쪽은 **애초에 만들지 않은 것과 같게** 되돌린다.
		if body.Headless && s.Tools != nil {
			s.Tools.Delete(toolID)
			log.Printf("[run] headless 롤백 — 멤버 등록 실패: tool=%s", toolID)
		}
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
		// KeepTools 는 헤드리스 멤버의 도구를 종료하지 않는다 (FR-HLM-4).
		// 보존한 도구는 이후 run status 의 고아 목록에 남는다 (FR-HLM-5).
		KeepTools bool `json:"keepTools"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeToolIOError(w, http.StatusBadRequest, "잘못된 JSON: "+err.Error())
		return
	}
	// 이미 끝난 Run 에 --force 를 주면 **정리 전용 진입**이다 (FR-WKT-8a).
	// 상태는 그대로 두고 남은 worktree 만 거둔다 — epoch 펜싱으로 aborted 된
	// Run 은 close 를 받지 못해 트리를 지울 경로가 아예 없었다.
	rec, pending, sweep, err := s.closeOrSweep(body.RunID, body.Force)
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
	// 헤드리스 도구는 Run 이 소유하므로 여기서 닫는다 (FR-HLM-4). 탭 부착 멤버의
	// 도구는 위 cleanup 목록으로 조정자에게 넘어간다 — 서버가 화면에 있는 것을
	// 말없이 죽이지 않는다.
	kept := s.closeHeadlessTools(rec, body.KeepTools)
	trees := s.cleanupWorktrees(rec, body.KeepWorktrees)
	residue := 0
	for _, t := range trees {
		if !t.Removed {
			residue++
		}
	}
	// 고아 판정이 closeHeadlessTools 뒤에 오는 것은 순서가 아니라 **의미**다 —
	// 앞서 세면 방금 거둔 도구까지 고아로 보고된다 (FR-HLM-5).
	log.Printf("[run] close id=%s members=%d force=%v sweep=%v worktrees=%d residue=%d keepTools=%v",
		rec.ID, len(rec.Members), body.Force, sweep, len(trees), residue, body.KeepTools)
	orphans := s.orphanHeadless(rec)
	// UX_REVISION_SRS FR-DEL-12: 끝난 Run 은 목록에 남지 않는다. 정리는 위에서
	// 이미 끝났으므로 여기서는 레코드만 지우고 방송한다 — purgeRun 을 부르면
	// 같은 정리를 두 번 돌게 된다.
	//
	// FR-DEL-9a: 남긴 것이 있으면 지우지 않는다. 잔여 worktree 도, `--keep-tools`
	// 로 살려 둔 헤드리스 도구도, 그것이 남아 있다는 사실을 아는 자리는 레코드
	// 하나뿐이다 (FR-WKT-12 · FR-HLM-5). 지우면 아무도 모르는 자원이 된다.
	if residue > 0 || len(kept) > 0 {
		log.Printf("[run] close 뒤 레코드 보존 id=%s residue=%d keptTools=%d",
			rec.ID, residue, len(kept))
	} else if _, err := s.Runs.Delete(rec.ID); err != nil {
		log.Printf("[run] close 뒤 레코드 삭제 실패 id=%s: %v", rec.ID, err)
	} else {
		s.broadcastLayout("run_changed", map[string]any{"runId": rec.ID})
	}
	writeJSON(w, map[string]any{
		"id": rec.ID, "short": rec.Short, "state": rec.State,
		"closedAt": rec.ClosedAt, "windowId": rec.WindowID, "cleanup": cleanup,
		"worktrees": trees, "residue": residue, "swept": sweep,
		"keptTools": kept, "orphans": orphans,
	})
}

// closeOrSweep 는 close 요청을 두 진입 중 하나로 보낸다 (FR-RUN-11, FR-WKT-8a).
// 종료된 Run 에 --force 가 없으면 종전대로 run_closed 로 거부된다.
func (s *Server) closeOrSweep(runID string, force bool) (run.Record, []run.Member, bool, error) {
	if force {
		if cur, ok := s.Runs.Get(runID); ok && cur.State != run.Open {
			rec, err := s.Runs.Sweep(runID)
			return rec, nil, true, err
		}
	}
	rec, pending, err := s.Runs.Close(runID, force)
	return rec, pending, false, err
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
