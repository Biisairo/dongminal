package httpapi

import (
	"log"
	"net/http"
	"strings"
	"time"

	"dongminal/internal/webserver/domain/run"
	"dongminal/internal/webserver/domain/worktree"
)

// 묶음 D — Run 수명 (UX_REVISION_SRS §3.1).
//
// 지금까지 Run 레코드는 지워지지 않았다 — close 도 abort 도 상태만 바꿨고,
// runs.json 은 한 번 열린 Run 을 영원히 들고 있었다. 목록이 끝난 Run 으로 차면
// 진행 중인 것을 고르는 일이 매번 검색이 된다.
//
// 여기서 삭제를 연다. **정리가 먼저다** (FR-DEL-8): worktree 를 지울 근거는
// 레코드에만 있으므로, 레코드를 먼저 지우면 트리가 영원히 남는다.

// reapInterval 은 자동 수거의 주기다 (FR-DEL-14). 조정자의 죽음은 이벤트로
// 오지 않는다 — 도구 종료 콜백은 데몬 경계 안쪽의 것이고, 서버는 `toolLive`
// 로 물어보는 편이 배선이 하나 적다.
const reapInterval = 15 * time.Second

// apiRunDelete implements DELETE /api/runs/{id} (FR-DEL-5/7).
func (s *Server) apiRunDelete(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/runs/")
	if id == "" || strings.Contains(id, "/") {
		writeToolIOError(w, http.StatusBadRequest, "run id 가 없다")
		return
	}
	rec, ok := s.Runs.Get(id)
	if !ok {
		writeRunError(w, run.ErrUnknownRun, nil)
		return
	}
	trees, err := s.purgeRun(rec, "manual", true)
	if err != nil {
		writeRunError(w, err, nil)
		return
	}
	residue := 0
	for _, t := range trees {
		if !t.Removed {
			residue++
		}
	}
	writeJSON(w, map[string]any{
		"id": rec.ID, "short": rec.Short, "state": rec.State,
		"worktrees": trees, "residue": residue,
	})
}

// purgeRun 은 레코드를 지우기까지의 순서 하나다 (FR-DEL-8~11).
//
// 워크스페이스 표식 해제 → 헤드리스 도구 종료 → worktree 정리 → 레코드 삭제 →
// 방송. 앞의 셋은 close 가 이미 하던 것이고, 이 함수는 그 뒤에 삭제를 붙인다.
//
// **탭 부착 멤버의 도구는 여기서도 닫지 않는다** (FR-BG-3) — 화면에 있는 것을
// 서버가 말없이 죽이지 않는다는 규약은 삭제에서도 같다.
func (s *Server) purgeRun(rec run.Record, why string, force bool) ([]worktree.Result, error) {
	s.markWorkspaceRun(rec, "", "") // 표식 해제
	s.closeHeadlessTools(rec, false)
	trees := s.cleanupWorktrees(rec, false)
	residue := 0
	for _, t := range trees {
		if !t.Removed {
			residue++
		}
	}
	// FR-DEL-9a: 자동 제거는 잔여를 남긴 채 지우지 않는다. 레코드가 그 트리를
	// 아는 유일한 자리이므로, 여기서 지우면 아무도 모르는 디렉터리가 된다.
	// 사용자가 고른 삭제(force)는 그 사실을 알고 고른 것이다 (FR-DEL-9).
	if residue > 0 && !force {
		log.Printf("[run] 자동 제거 보류 id=%s short=%s residue=%d — 잔여 worktree 가 있다",
			rec.ID, rec.Short, residue)
		return trees, nil
	}
	if _, err := s.Runs.Delete(rec.ID); err != nil {
		return nil, err
	}
	// FR-DEL-17: 사용자가 만들지 않은 삭제도 근거를 남긴다.
	log.Printf("[run] delete id=%s short=%s state=%s why=%s members=%d worktrees=%d residue=%d",
		rec.ID, rec.Short, rec.State, why, len(rec.Members), len(trees), residue)
	// FR-DEL-11: 열려 있는 Run 탭은 이것으로 "사라진 Run" 이 된다. 탭은 닫지 않는다.
	s.broadcastLayout("run_changed", map[string]any{"runId": rec.ID})
	return trees, nil
}

// reapRuns 는 자동 제거를 한 번 돈다 (FR-DEL-12/13/16). 지운 건수를 돌려준다.
func (s *Server) reapRuns() int {
	if s.Runs == nil {
		return 0
	}
	targets := s.Runs.ReapTargets(s.toolLive)
	n := 0
	for _, rec := range targets {
		why := "coordinator-gone"
		if rec.State != run.Open {
			why = "ended-" + string(rec.State)
		}
		if _, err := s.purgeRun(rec, why, false); err != nil {
			log.Printf("[run] 자동 제거 실패 id=%s: %v", rec.ID, err)
			continue
		}
		// 보류(FR-DEL-9a)는 수거가 아니다 — 레코드가 그대로 있으면 세지 않는다.
		if _, still := s.Runs.Get(rec.ID); !still {
			n++
		}
	}
	return n
}

// StartRunReaper 는 수거 루프를 띄운다 (FR-DEL-14/18). 부팅 직후 한 번 돌고,
// 이후 reapInterval 마다 돈다. stop 이 닫히면 끝난다.
func (s *Server) StartRunReaper(stop <-chan struct{}) {
	if s.Runs == nil {
		return
	}
	go func() {
		s.reapRuns()
		t := time.NewTicker(reapInterval)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				s.reapRuns()
			}
		}
	}()
}
