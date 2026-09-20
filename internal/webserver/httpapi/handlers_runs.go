// 묶음 R — Run 레코드의 서버 계층이다 (RUN_ORCHESTRATION_SRS §3.1).
//
// Run 은 공간 계층의 레벨이 아니라 직교 축이다. 여기 있는 것은 "무엇이 누구의
// 것인가"의 기록과 조회이며, **무엇을 언제 시킬지는 조정자 에이전트가 정한다**
// (DC-RUN-1). 서버는 스케줄러가 되지 않는다.
package httpapi

import (
	"context"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/pollwait"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/run"
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
//
// **판정은 여기 없다.** sentinel → (status, code) 는 `apierr.Runs` 테이블이
// 소유한다 (DEEPENING_REFACTOR_SRS FR-DPN-6). 이 표면의 코드가 sentinel 의
// 메시지 그 자체라는 계약은 그대로다 — 테이블이 `.Error()` 를 참조한다.
//
// 남는 것 둘: 이 패키지 자신의 sentinel 하나(`errIsolationUnavailable` — domain
// 이 아니라 여기가 만든다)와, 미분류 실패의 기본값(코드 = 오류 문자열)이다.
func writeRunError(w http.ResponseWriter, err error, extra map[string]any) {
	status := http.StatusInternalServerError
	name := err.Error()
	switch {
	case errors.Is(err, errIsolationUnavailable):
		status, name = http.StatusServiceUnavailable, errIsolationUnavailable.Error()
	default:
		if s, c, ok := apierr.Runs.Lookup(err); ok {
			status, name = s, c
		}
	}
	body := map[string]any{"error": name, "detail": err.Error()}
	for k, v := range extra {
		body[k] = v
	}
	// FR-ERR-7: 본문의 `error` 와 같은 값을 헤더로도 낸다.
	w.Header().Set(apierr.CodeHeader, name)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// apiRunsGet implements GET /api/runs[?id=] (FR-RUN-8).
// runMember 는 memberId 를 회원으로 옮기고, 없으면 이 표면의 오류로 답한다
// (DRIFT_RECLAIM_SRS FR-DRC-11).
//
// **`sender_not_member` 를 쓰지 않는다** — 그것은 보고 **권한**의 사유이고,
// 여기서 실패한 것은 조회다. 뭉뚱그리면 조정자가 권한 문제로 오진한다. 그 구분이
// 네 자리에 흩어져 있으면 한 곳만 다른 사유를 쓰게 된다.
func (s *Server) runMember(w http.ResponseWriter, memberID string) (run.Record, run.Member, bool) {
	rec, m, ok := s.Runs.FindMember(memberID)
	if !ok {
		writeRunError(w, run.ErrUnknownMember, map[string]any{"memberId": memberID})
		return run.Record{}, run.Member{}, false
	}
	return rec, m, true
}

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
	if !decodeJSONBody(w, r, &body) {
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
	dmlog.Infof(nil, "[run] start id=%s short=%s projection=%s isolation=%s coordinator=%s",
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
	if !decodeJSONBody(w, r, &body) {
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
		if toolID, err = s.createHeadlessTool(cwd, ""); err != nil {
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
		s.rollbackMemberAdd(mi, body.Headless, toolID)
		writeRunError(w, err, nil)
		return
	}
	dmlog.Infof(nil, "[run] member run=%s member=%s role=%s agent=%s tool=%s tab=%s",
		body.RunID, m.ID, m.Role, m.Agent, m.ToolID, m.TabID)
	writeJSON(w, s.memberAddedView(body.RunID, m))
}

// rollbackMemberAdd 는 등록에 실패한 멤버의 보상 삭제다 — 도구를 만들고 멤버 등록에
// 실패하면 그 도구는 누구의 것도 아니다. FR-HLM-5 가 말하는 고아(Run 이 끝난 뒤
// 남은 도구)와는 다른 것이며, 이쪽은 **애초에 만들지 않은 것과 같게** 되돌린다.
func (s *Server) rollbackMemberAdd(mi *memberIsolation, headless bool, toolID string) {
	if headless && s.Tools != nil {
		// `GO-8`: 오류를 **명시로** 무시한다. 이 경로에서 "이미 없다" 는 정상이며
		// (목록이 앞서 걷혔거나 사용자가 두 번 눌렀다) 치울 것이 없다는 뜻이다.
		// 버리는 것과 판단한 것은 다르므로 그 사실을 여기 적어 둔다.
		_ = s.Tools.Delete(toolID)
		dmlog.Errorf(nil, "[run] headless 롤백 — 멤버 등록 실패: tool=%s", toolID)
	}
	s.rollbackMember(mi)
}

// memberAddedView 는 등록 응답이다 — 표식을 쓰고 프리앰블을 싣는다. 프리앰블을
// 응답에 실어 보내는 이유는 조정자가 uuid 를 손으로 옮겨 적을 일이 없어야 그
// 계열의 결함이 사라지기 때문이다 (FR-PRE-1).
func (s *Server) memberAddedView(runID string, m run.Member) memberView {
	view := memberView{Member: m, State: s.deriveMemberState(m)}
	if rec, ok := s.Runs.Get(runID); ok {
		s.markWorkspaceRun(rec, m.TabID, rec.ID)
		view.Preamble = run.Preamble(rec, m)
	}
	return view
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
	/**
	 * UX_BATCH6_SRS FR-RUN-4·5: **늦게 오는 인수인계를 기다린다.**
	 *
	 *   이전 동작: 승계가 시한 안에 요약을 받지 못하면 그대로 끝났고, 뒤늦게
	 *             도착한 요약은 전임자 레코드에만 남아 후임에게 닿지 않았다
	 *   새  동작: 청해 두고 아직 오지 않았으면 여기서 상한만큼 기다린다
	 *   이유:     프리앰블은 이미 전임자의 요약을 **만드는 시점에 다시 읽는다**
	 *             (`HandoffClause`). 빠진 것은 "아직 오는 중" 이라는 사실뿐이고,
	 *             그것을 알면 기다릴 수 있다 — 어느 쪽이 빠르든 문서가 버려지지
	 *             않는다 (접수 ⑫)
	 *
	 * 기다린 뒤에는 표식을 지운다. 오지 않은 것은 오지 않은 것이며, 다음 조회가
	 * 같은 시간을 또 먹어서는 안 된다.
	 */
	if s.Runs.HandoffWaiting(m.ID) {
		if s.waitHandoff(r.Context(), m.ID) != nil {
			// 묻는 쪽이 사라졌다 — 표식은 그대로 둔다. 다음 조회가 이어서 기다린다.
			return
		}
		// SAFETY_CORRECTNESS_SRS FR-SAF-5: **`rec` 도 다시 읽는다.**
		//
		//   이전 동작: 멤버만 다시 읽었다. 그래도 동작한 것은 `rec.Members` 가
		//             저장소의 배열을 **공유**했기 때문이다 — 늦게 도착한 요약이
		//             낡은 `rec` 를 통해 비쳤다. 잠금 밖의 읽기였으므로 그것은
		//             데이터 레이스였고, 이 종단은 그 레이스에 기대고 있었다
		//   새  동작: 조회가 복사본을 주므로 `rec` 를 다시 읽어 최신으로 만든다
		//   이유:     `HandoffClause` 가 전임자의 요약을 **`rec.Members` 에서**
		//             찾는다. 위 주석이 말한 "만드는 시점에 다시 읽는다" 가
		//             성립하려면 그 시점의 `rec` 가 최신이어야 한다
		if curRec, cur, ok := s.Runs.FindMember(m.ID); ok {
			rec, m = curRec, cur
		}
	}
	writeJSON(w, map[string]any{
		"runId": rec.ID, "memberId": m.ID, "role": m.Role, "agent": m.Agent,
		"tabId": m.TabID, "toolId": m.ToolID, "runState": rec.State,
		"preamble": run.Preamble(rec, m),
	})
}

// waitHandoff 는 전임자의 요약이 도착하기를 상한 안에서 기다린다 (FR-RUN-4).
//
// 상한을 넘기면 **기다림을 접는다** (FR-RUN-5) — 없는 것은 없다고 말하며, 그
// 사실은 프리앰블의 인수인계 절이 이미 적는다. 요청이 먼저 끊기면 접지 않고
// 그 오류를 돌려준다 — 오지 않은 것과 묻는 쪽이 사라진 것은 다르다.
func (s *Server) waitHandoff(ctx context.Context, memberID string) error {
	err := pollwait.Until(ctx, handoffPreambleWait, handoffPollInterval, func() bool {
		return !s.Runs.HandoffWaiting(memberID)
	})
	if !errors.Is(err, pollwait.ErrTimeout) {
		return err
	}
	dmlog.Infof(nil, "[run] handoff 기다림 종료 member=%s wait=%s — 요약 없이 프리앰블을 낸다",
		memberID, handoffPreambleWait)
	s.Runs.GiveUpHandoff(memberID)
	return nil
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
	if !decodeJSONBody(w, r, &body) {
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
	dmlog.Infof(nil, "[run] report run=%s member=%s tool=%s outcome=%s files=%d",
		m.RunID, m.ID, m.ToolID, m.Outcome, len(m.FilesModified))
	writeJSON(w, memberView{Member: m, State: m.State})
}
