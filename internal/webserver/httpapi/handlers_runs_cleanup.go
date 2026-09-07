package httpapi

import (
	"log"
	"time"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/webserver/domain/run"
)

// Run 을 접을 때의 화면 정리 (UX_BATCH6_SRS FR-RUN-6~9).
//
// **종전에는 조정자의 몫이었다.** `close` 는 정리 대상 목록만 돌려주고, `/exit` →
// `close-tab` 은 조정자가 직접 쳐야 했다(SKILL.md §8). 그 절차를 건너뛴 조정자가
// 실제로 있었고, 남은 것은 죽은 에이전트의 탭과 아무도 앉지 않은 빈 터미널이다 —
// 접수 ⑩·⑬이 그 둘이다.
//
// 서버가 대신하는 것이 옳은 이유: 무엇을 닫아야 하는지 아는 것은 **기록**이고,
// 기록은 서버에 있다. 조정자는 그것을 다시 읽어 옮겨 적을 뿐이며, 옮겨 적는
// 단계가 있으면 빠뜨릴 수 있다.
//
// 종전 주석이 "도구를 여기서 닫지 않는다 — 확인창이 뜬다" 고 적은 그 이유는
// 그대로다. 그래서 **먼저 끝내고 나서 닫는다** — `/exit` 로 에이전트를 정상
// 종료시키고, 셸로 돌아온 것을 확인한 뒤에 탭을 닫는다.

const (
	// exitSettleTimeout 은 `/exit` 뒤 셸로 돌아오기를 기다리는 상한이다.
	//
	// 넘겨도 닫는다. 응답하지 않는 에이전트를 이유로 정리가 멎으면 그 Run 은
	// 영영 화면에 남는다 — 승계가 무응답 멤버를 다루는 것과 같은 판단이다.
	exitSettleTimeout = 20 * time.Second
	exitPollInterval  = 250 * time.Millisecond
)

// closeRunTabs 는 이 Run 이 쓰던 탭을 닫는다 (FR-RUN-6·7).
//
// 돌려주는 것은 **무엇을 어떻게 했는가**다 (FR-RUN-9). 조용히 사라지는 자원이
// 없어야 한다는 규약은 worktree 잔여물·보존 도구와 같다.
func (s *Server) closeRunTabs(rec run.Record, keep bool) []map[string]any {
	out := []map[string]any{}
	if keep {
		// FR-RUN-8: `--keep-tools` 는 아무것도 닫지 않는다 — 종전 규약 그대로다.
		return out
	}
	if s.Commands == nil {
		return out
	}

	// ① 살아 있는 멤버에게 정상 종료를 청한다. 전부에게 먼저 보내고 나서
	//    기다린다 — 하나씩 보내고 기다리면 멤버 수만큼 상한이 곱해진다.
	type target struct {
		memberID, role, toolID, tabID string
		exited                        bool
	}
	targets := []target{}
	for _, m := range rec.Members {
		if m.TabID == "" || !s.toolLive(m.ToolID) {
			continue
		}
		t := target{memberID: m.ID, role: m.Role, toolID: m.ToolID, tabID: m.TabID}
		// **도는 것이 없으면 청하지 않는다.** 셸 프롬프트에 `/exit` 를 치면
		// "그런 파일이 없다" 한 줄이 남을 뿐이고, 그것은 정리가 아니라 잡음이다.
		// 에이전트가 이미 끝난 탭이 그 경우다.
		if cmd := exitCommandFor(m.Agent); cmd != "" && s.ToolIO != nil &&
			s.Tools != nil && s.Tools.Busy(m.ToolID) {
			if err := s.ToolIO.SendPaste(m.ToolID, []byte(cmd), true); err != nil {
				log.Printf("[run] close 정리: 종료 명령 실패 member=%s tool=%s: %v", m.ID, m.ToolID, err)
			}
		}
		targets = append(targets, t)
	}
	ids := make([]string, 0, len(targets))
	for _, t := range targets {
		ids = append(ids, t.toolID)
	}
	s.waitToolsIdle(ids)

	// ② 탭을 닫는다. 좌표가 아니라 uuid 를 싣는다 — 브라우저의 `closeTab` 이
	//    `location` 을 그렇게 해석한다 (app-cmd.js `_resolveLocation`).
	for i := range targets {
		targets[i].exited = s.Tools == nil || !s.Tools.Busy(targets[i].toolID)
		// `force` 인 이유는 위에서 이미 종료를 청하고 기다렸기 때문이다 —
		// 그러고도 도는 프로세스에 확인창이 뜨면 무인 정리가 멎는다 (FR-RUN-6).
		s.broadcastLayout("closeTab", map[string]any{"location": targets[i].tabID, "force": true})
		out = append(out, map[string]any{
			"memberId": targets[i].memberID, "role": targets[i].role,
			"tabId": targets[i].tabID, "closed": true, "exited": targets[i].exited,
		})
	}

	// ③ FR-RUN-7: 전용 창에 남은 **빈 탭**. 멤버가 결속되지 않은 채 셸만 도는
	//    자리이며, 조정자가 만들었으나 쓰이지 않은 탭이 그것이다.
	for _, e := range s.emptyRunTabs(rec) {
		s.broadcastLayout("closeTab", map[string]any{"location": e, "force": true})
		out = append(out, map[string]any{"tabId": e, "closed": true, "empty": true})
	}
	return out
}

// waitToolsIdle 는 목록의 도구가 전부 셸로 돌아오기를 기다린다.
//
// 상한을 넘겨도 돌아온다 — 기다림은 확인창을 피하기 위한 것이지 정리의 조건이
// 아니다 (FR-RUN-6 의 근거).
func (s *Server) waitToolsIdle(ids []string) {
	if s.Tools == nil || len(ids) == 0 {
		return
	}
	deadline := time.Now().Add(exitSettleTimeout)
	for time.Now().Before(deadline) {
		busy := false
		for _, id := range ids {
			if s.Tools.Busy(id) {
				busy = true
				break
			}
		}
		if !busy {
			return
		}
		time.Sleep(exitPollInterval)
	}
	log.Printf("[run] close 정리: 종료 대기 상한 초과 — 그대로 닫는다 (%d개)", len(ids))
}

// emptyRunTabs 는 **전용 창**에 남은 비-멤버 탭의 uuid 다 (FR-RUN-7).
//
// 전용 창으로 한정하는 이유는 소유권이다. 그 창은 이 Run 을 위해 만들어졌으므로
// 그 안의 자리는 전부 이 Run 의 것이고, 인라인 Run(사용자의 창을 나눠 쓰는 것)의
// 탭은 사용자의 것이다 — 남의 자리를 서버가 닫지 않는다.
func (s *Server) emptyRunTabs(rec run.Record) []string {
	// 투영을 함께 본다 — `WindowID` 만으로는 "전용 창" 이 보장되지 않는다.
	// 판정과 주석이 어긋나면 어느 쪽이 뜻인지 말할 수 없다.
	if rec.Projection != run.DedicatedWindow || rec.WindowID == "" || s.WorkIndex == nil {
		return nil
	}
	member := map[string]struct{}{}
	for _, m := range rec.Members {
		if m.TabID != "" {
			member[m.TabID] = struct{}{}
		}
	}
	out := []string{}
	for _, e := range s.WorkIndex.Entries() {
		if e.WindowUUID != rec.WindowID || e.TabUUID == "" {
			continue
		}
		if _, ok := member[e.TabUUID]; ok {
			continue
		}
		out = append(out, e.TabUUID)
	}
	return out
}

// exitCommandFor 는 그 에이전트의 정상 종료 명령이다. 모르는 에이전트에는 빈
// 문자열이며, 그때는 종료를 청하지 않고 탭만 닫는다 — 지어낸 명령을 셸에 치는
// 것보다 낫다.
func exitCommandFor(agent string) string {
	a, err := agentadapter.Get(agent)
	if err != nil {
		return ""
	}
	return a.ExitCommand
}
