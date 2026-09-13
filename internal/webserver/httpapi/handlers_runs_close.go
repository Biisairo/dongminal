package httpapi

import (
	"net/http"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/domain/run"
)

// apiRunClose implements POST /api/runs/close (FR-RUN-10/11).
//
// **정리까지 한다** (UX_BATCH6_SRS FR-RUN-6~9).
//
//	이전 동작: 정리 대상 목록만 돌려주고, 에이전트 종료 명령 → `close-tab` 은
//	          조정자가 직접 쳤다
//	새  동작: 여기서 `/exit` 를 보내고, 셸로 돌아온 뒤 탭을 닫는다. 전용 창에
//	          남은 빈 탭도 함께 거둔다
//	이유:     접수 ⑩·⑬ — 그 절차를 건너뛴 조정자가 죽은 에이전트의 탭과 아무도
//	          앉지 않은 터미널을 남겼다. 무엇을 닫아야 하는지 아는 것은 기록이고,
//	          옮겨 적는 단계가 있으면 빠뜨릴 수 있다
//
// 확인창을 피하는 종전 근거(FR-BG-3)는 그대로다 — 그래서 **먼저 끝내고 나서**
// 닫는다. `--keep-tools` 면 아무것도 닫지 않는다 (FR-RUN-8).
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
	if !decodeJSONBody(w, r, &body) {
		return
	}
	// 이미 끝난 Run 에 --force 를 주면 **정리 전용 진입**이다 (FR-WKT-8a).
	// 상태는 그대로 두고 남은 worktree 만 거둔다 — epoch 펜싱으로 aborted 된
	// Run 은 close 를 받지 못해 트리를 지울 경로가 아예 없었다.
	rec, pending, sweep, err := s.closeOrSweep(body.RunID, body.Force)
	if err != nil {
		writeRunError(w, err, s.unreportedExtra(pending))
		return
	}
	cleanup := s.cleanupTargets(rec)
	// 헤드리스 도구는 Run 이 소유하므로 여기서 닫는다 (FR-HLM-4). 탭 부착 멤버의
	// 도구는 위 cleanup 목록으로 조정자에게 넘어간다 — 서버가 화면에 있는 것을
	// 말없이 죽이지 않는다.
	kept := s.closeHeadlessTools(rec, body.KeepTools)
	// UX_BATCH6_SRS FR-RUN-6·7: **탭 부착 멤버의 정리도 여기서 한다.** 종전에는
	// `cleanup` 목록만 돌려주고 `/exit` → `close-tab` 을 조정자에게 맡겼고, 그
	// 절차를 건너뛴 조정자가 남긴 것이 접수 ⑩(닫히지 않는 세션·창)과
	// ⑬(빈 터미널)이다. 무엇을 닫아야 하는지 아는 것은 기록이고 기록은 여기 있다.
	closed := s.closeRunTabs(r.Context(), rec, body.KeepTools)
	// UX_BATCH6_SRS FR-RUN-6d: 표식 해제는 **닫고 난 뒤, 남은 자리에만** 한다.
	//
	//   이전 동작: 닫기 전에 표식을 지워 workspace.json 을 썼다 (rev+1)
	//   새  동작: 닫은 탭은 대상에서 빼고, 뺄 것이 없으면 쓰지 않는다
	//   이유:     쓰기가 rev 를 올린 직후 `closeTab` 방송이 나가면, 탭을 지운
	//             브라우저의 PUT 이 **409** 를 받는다. 그쪽의 해소는 원격 채택이라
	//             자기 삭제를 버리고, 탭이 되살아나 전용 창이 화면에 남는다
	//             (ubuntu 러너 실측 · e2e `skill-contract`). 사라질 자리의 표식은
	//             지울 것이 없다 — 자리가 사라진다.
	s.markWorkspaceRunExcept(rec, "", "", closedTabIDs(closed))
	trees := s.cleanupWorktrees(r.Context(), rec, body.KeepWorktrees)
	residue := 0
	for _, t := range trees {
		if !t.Removed {
			residue++
		}
	}
	// 고아 판정이 closeHeadlessTools 뒤에 오는 것은 순서가 아니라 **의미**다 —
	// 앞서 세면 방금 거둔 도구까지 고아로 보고된다 (FR-HLM-5).
	dmlog.Infof(nil, "[run] close id=%s members=%d force=%v sweep=%v worktrees=%d residue=%d keepTools=%v",
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
		dmlog.Infof(nil, "[run] close 뒤 레코드 보존 id=%s residue=%d keptTools=%d",
			rec.ID, residue, len(kept))
	} else if _, err := s.Runs.Delete(rec.ID); err != nil {
		dmlog.Errorf(nil, "[run] close 뒤 레코드 삭제 실패 id=%s: %v", rec.ID, err)
	} else {
		s.broadcastLayout("run_changed", map[string]any{"runId": rec.ID})
	}
	writeJSON(w, map[string]any{
		"id": rec.ID, "short": rec.Short, "state": rec.State,
		"closedAt": rec.ClosedAt, "windowId": rec.WindowID, "cleanup": cleanup,
		"worktrees": trees, "residue": residue, "swept": sweep,
		"keptTools": kept, "orphans": orphans,
		// FR-RUN-9: 무엇을 닫았는가. `cleanup` 은 **대상**이고 이쪽은 **결과**다.
		"closedTabs": closed,
	})
}

// unreportedExtra 는 close 거부의 부가 정보다 — 아직 보고하지 않은 멤버가 있으면
// 그 목록을 싣는다 (FR-RUN-6 의 거부 사유를 조정자가 읽는다).
func (s *Server) unreportedExtra(pending []run.Member) map[string]any {
	if len(pending) == 0 {
		return nil
	}
	items := make([]memberView, 0, len(pending))
	for _, m := range pending {
		items = append(items, memberView{Member: m, State: s.deriveMemberState(m)})
	}
	return map[string]any{"unreported": items}
}

// cleanupTargets 는 close 응답의 `cleanup` — 멤버마다 도구·탭·생존의 **대상** 목록이다.
func (s *Server) cleanupTargets(rec run.Record) []map[string]any {
	cleanup := make([]map[string]any, 0, len(rec.Members))
	for _, m := range rec.Members {
		cleanup = append(cleanup, map[string]any{
			"memberId": m.ID, "role": m.Role, "toolId": m.ToolID,
			"tabId": m.TabID, "agent": m.Agent, "live": s.toolLive(m.ToolID),
		})
	}
	return cleanup
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
