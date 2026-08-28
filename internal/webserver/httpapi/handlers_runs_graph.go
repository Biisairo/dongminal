// 묶음 V — Run 시각화의 서버측이다 (ORCHESTRATION_V2_SRS §3.5).
//
// 대시보드는 단일 종단에서 필요한 것을 한 번에 받는다 — 요약·멤버 전량·메시지
// 로그·타임라인 (FR-RVZ-15). 관계 그래프의 엣지는 **실제로 오간 신뢰 채널
// 메시지**이며, 그 원천이 Record.Messages 다 (본문은 담지 않는다 — NFR-RVZ-3).
package httpapi

import (
	"log"
	"net/http"
	"sort"
	"strings"

	"dongminal/internal/webserver/domain/run"
)

// runGraphView 는 대시보드가 받는 전부다 (FR-RVZ-15).
//
// run.Record 를 embed 하지 않고 필드를 하나씩 고른다. embed 하면 Brief·Summary·
// SessionID 처럼 **지금은 없지만 나중에 늘어날** 필드까지 자동으로 새어 나가고,
// 그때 이 파일을 고치는 사람은 아무도 없다 (NFR-RVZ-3 / V-RVZ-10). 명시 선택이
// 규율을 타입으로 바꾼다. handlers_runs_peers.go 의 peerView 가 같은 판단이다.
//
// 도해(FR-RVZ-10)의 `패턴: debate` 행은 없다. Run 레코드에 패턴 필드가 없고,
// 신설하지 않는 이유는 범위가 아니라 NFR-RVZ-4 다 — `dmctl run status` 로 읽히지
// 않는 것을 시각화가 만들어 내지 않는다 (SRS §3.5.3 의 조정자 판정).
type runGraphView struct {
	RunID             string        `json:"runId"`
	Short             string        `json:"short"`
	Objective         string        `json:"objective"`
	State             run.State     `json:"state"`
	Isolation         run.Isolation `json:"isolation"`
	CreatedAt         int64         `json:"createdAt"`
	ClosedAt          int64         `json:"closedAt,omitempty"`
	CoordinatorToolID string        `json:"coordinatorToolId,omitempty"`

	Members  []graphMember  `json:"members"`
	Edges    []graphEdge    `json:"edges"`
	Messages []run.MsgEvent `json:"messages"`
	Timeline []graphEvent   `json:"timeline"`
}

// graphMember 는 노드 하나가 그려지는 데 필요한 사실만 담는다 (FR-RVZ-12).
//
// Brief·Summary·SessionID·HandoffSummary 가 **없는 것이 요점이다**. brief 전문은
// 프리앰블의 것이고, transcript 경로(SessionID)는 관측 층의 것이며, 둘 다 그래프가
// 그리는 데 쓰이지 않는다.
type graphMember struct {
	ID       string `json:"id"`
	Role     string `json:"role"`
	Agent    string `json:"agent"`
	ToolID   string `json:"toolId"`
	TabID    string `json:"tabId,omitempty"`
	Headless bool   `json:"headless,omitempty"`

	State   run.MemberState `json:"state"`
	Outcome run.Outcome     `json:"outcome,omitempty"`

	ContextRatio float64 `json:"contextRatio,omitempty"`
	ContextLevel string  `json:"contextLevel,omitempty"`
	CompactCount int     `json:"compactCount,omitempty"`

	SucceededBy   string `json:"succeededBy,omitempty"`
	SucceededFrom string `json:"succeededFrom,omitempty"`

	Worktree   *graphWorktree `json:"worktree,omitempty"`
	CreatedAt  int64          `json:"createdAt"`
	ReportedAt int64          `json:"reportedAt,omitempty"`
}

// graphWorktree 는 카드 한 줄(`wt: …/a1b2`)에 필요한 두 값이다. Base·Removed·
// Residue 는 정리의 사실이고 그래프의 관심사가 아니다.
type graphWorktree struct {
	Branch string `json:"branch,omitempty"`
	Path   string `json:"path,omitempty"`
}

// graphEdge 는 (from,to) 로 접은 메시지 흐름이다. 방향이 있다 — 누가 누구에게
// 말했는지가 팀의 모양이고, 합치면 그 모양이 사라진다 (FR-RVZ-12).
type graphEdge struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Count  int    `json:"count"`
	LastAt int64  `json:"lastAt"`
}

// graphEvent 는 타임라인 한 줄이다 (FR-RVZ-10 의 넷째 영역).
type graphEvent struct {
	At       int64  `json:"at"`
	Kind     string `json:"kind"`
	MemberID string `json:"memberId,omitempty"`
	Text     string `json:"text,omitempty"`
}

// 타임라인 항목의 종류다. 전부 레코드에서 직접 읽히는 사실이며, 시각화만 아는
// 사건은 없다 (NFR-RVZ-4).
const (
	graphEventRunStart  = "run_start"
	graphEventMemberAdd = "member_add"
	graphEventReport    = "report"
	graphEventSucceed   = "succeed"
	graphEventClose     = "close"
)

// apiRunGraph implements GET /api/runs/{id}/graph (FR-RVZ-15).
//
// 없는 Run 은 **404** 다 (V-RVZ-9). 빈 그래프로 답하지 않는다 — 탭이 "이 Run 은
// 더 이상 없다"를 그리려면 그 사실이 응답에 있어야 하고, 멤버 0명인 Run 과
// 사라진 Run 은 다른 것이다 (FR-RVZ-9).
func (s *Server) apiRunGraph(w http.ResponseWriter, r *http.Request) {
	if !s.runsReady(w) {
		return
	}
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/runs/"), "/graph")
	rec, ok := s.Runs.Get(id)
	if !ok {
		writeRunError(w, run.ErrUnknownRun, map[string]any{"runId": id})
		return
	}
	writeJSON(w, s.graphOf(rec))
}

// graphOf projects a Record onto what the dashboard draws.
func (s *Server) graphOf(rec run.Record) runGraphView {
	return runGraphView{
		RunID:             rec.ID,
		Short:             rec.Short,
		Objective:         rec.Objective,
		State:             rec.State,
		Isolation:         rec.Isolation,
		CreatedAt:         rec.CreatedAt,
		ClosedAt:          rec.ClosedAt,
		CoordinatorToolID: rec.CoordinatorToolID,
		Members:           s.graphMembers(rec),
		Edges:             graphEdges(rec.Messages),
		Messages:          graphMessages(rec.Messages),
		Timeline:          graphTimeline(rec),
	}
}

func (s *Server) graphMembers(rec run.Record) []graphMember {
	out := make([]graphMember, 0, len(rec.Members))
	for _, m := range rec.Members {
		g := graphMember{
			ID:            m.ID,
			Role:          m.Role,
			Agent:         m.Agent,
			ToolID:        m.ToolID,
			TabID:         m.TabID,
			Headless:      m.Headless,
			State:         s.graphMemberState(m),
			Outcome:       m.Outcome,
			ContextRatio:  m.ContextRatio,
			ContextLevel:  m.ContextLevel,
			CompactCount:  m.CompactCount,
			SucceededBy:   m.SucceededBy,
			SucceededFrom: m.SucceededFrom,
			CreatedAt:     m.CreatedAt,
			ReportedAt:    m.ReportedAt,
		}
		if m.Worktree != nil {
			g.Worktree = &graphWorktree{Branch: m.Worktree.Branch, Path: m.Worktree.Path}
		}
		out = append(out, g)
	}
	return out
}

// graphMemberState 는 파생 상태를 쓰되 **승계는 기록이 이긴다** (FR-CBG-10).
//
// deriveMemberState 는 succeeded 를 모른다 — 도구가 죽었으면 lost 로 접는다.
// 승계된 멤버의 도구는 흔히 죽어 있고, 그러면 승계 화살표를 그릴 근거가 노드
// 상태에서 사라진다 (V-RVZ-7). 넘긴 것은 잃은 것이 아니다.
func (s *Server) graphMemberState(m run.Member) run.MemberState {
	if m.State == run.Succeeded {
		return run.Succeeded
	}
	return s.deriveMemberState(m)
}

// graphEdges folds the message log into directed edges.
//
// 순서는 **처음 등장한 순**이다. map 순회 순서를 그대로 내면 같은 Run 이 볼 때마다
// 다른 배열이 되고, 그것은 FR-RVZ-11 의 결정성 요구를 서버가 먼저 깨는 것이다.
func graphEdges(msgs []run.MsgEvent) []graphEdge {
	out := make([]graphEdge, 0, len(msgs))
	at := map[[2]string]int{}
	for _, ev := range msgs {
		key := [2]string{ev.From, ev.To}
		i, ok := at[key]
		if !ok {
			at[key] = len(out)
			out = append(out, graphEdge{From: ev.From, To: ev.To, Count: 1, LastAt: ev.At})
			continue
		}
		out[i].Count++
		if ev.At > out[i].LastAt {
			out[i].LastAt = ev.At
		}
	}
	return out
}

// graphMessages 는 원본 이벤트를 그대로 낸다 — 이미 500건으로 잘려 있다
// (run.MaxMessages). nil 을 빈 배열로 바꾸는 이유는 프론트가 `.length` 를 바로
// 읽기 때문이다.
func graphMessages(msgs []run.MsgEvent) []run.MsgEvent {
	if msgs == nil {
		return []run.MsgEvent{}
	}
	return msgs
}

// graphTimeline 는 레코드에서 사건을 읽어 시간순으로 편다.
//
// 승계된 멤버는 member_add 를 내지 않는다 — 그 멤버가 온 것이 곧 승계이고, 같은
// 시각에 두 줄을 내면 타임라인이 같은 사실을 두 번 말한다.
func graphTimeline(rec run.Record) []graphEvent {
	out := []graphEvent{{At: rec.CreatedAt, Kind: graphEventRunStart, Text: rec.Objective}}
	for _, m := range rec.Members {
		if m.SucceededFrom != "" {
			out = append(out, graphEvent{
				At: m.CreatedAt, Kind: graphEventSucceed, MemberID: m.ID, Text: m.Role,
			})
		} else {
			out = append(out, graphEvent{
				At: m.CreatedAt, Kind: graphEventMemberAdd, MemberID: m.ID, Text: m.Role,
			})
		}
		if m.Reported() {
			// 본문(Summary)이 아니라 **결말**만 낸다 (NFR-RVZ-3).
			out = append(out, graphEvent{
				At: m.ReportedAt, Kind: graphEventReport, MemberID: m.ID, Text: string(m.Outcome),
			})
		}
	}
	if rec.ClosedAt != 0 {
		out = append(out, graphEvent{At: rec.ClosedAt, Kind: graphEventClose, Text: rec.AbortReason})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At < out[j].At })
	return out
}

// ── 메시지 기록 (FR-RVZ-14) ─────────────────────────

// recordRunMessage 는 배달된 신뢰 채널 메시지 한 건을 Run 에 적고 대시보드를
// 깨운다 (FR-RVZ-14 / FR-RVZ-16).
//
// **오류를 밖으로 내지 않는다.** 이 함수가 불릴 때 메시지는 이미 배달됐고, 기록
// 실패가 전송 실패로 보고되면 발신자는 보내지 않은 줄 알고 다시 보낸다. 관측이
// 팀을 멈추게 하면 본말전도다 (FR-CBG-8 이 통지에 대해 한 판단과 같다).
func (s *Server) recordRunMessage(fromToolID, toToolID string, size int) {
	if s.Runs == nil {
		return
	}
	rec, ok := s.messageRun(fromToolID, toToolID)
	if !ok {
		return
	}
	from, okFrom := s.graphParty(rec, fromToolID)
	to, okTo := s.graphParty(rec, toToolID)
	if !okFrom || !okTo {
		// 어느 한쪽을 그래프의 이름으로 부를 수 없다. 이름 없는 끝을 가진 엣지는
		// 대시보드가 그릴 수 없고, 그리지 못하는 것을 적으면 NFR-RVZ-4 가 뒤집힌다.
		return
	}
	ev := run.MsgEvent{From: from, To: to, Kind: run.MsgKindAgent, Size: size}
	if err := s.Runs.AppendMessage(rec.ID, ev); err != nil {
		log.Printf("[run] 메시지 기록 생략 run=%s from=%s to=%s: %v", rec.Short, from, to, err)
		return
	}
	s.broadcastLayout("run_changed", map[string]any{"runId": rec.ID})
}

// messageRun 은 이 메시지를 **어느 Run 의 사실로 적을지** 고른다.
//
// 수신자의 Run 이 먼저다. 근거는 "그 Run 의 관심사인가" 이며 도착지가 관심의
// 중심이다 — 다른 Run 의 멤버에게서 온 지시도, 조정자의 지시도, 받는 팀에게는
// 자기 팀에 들어온 일이다. 수신자가 멤버가 아니면(조정자면) 발신자의 Run 으로
// 떨어진다.
func (s *Server) messageRun(fromToolID, toToolID string) (run.Record, bool) {
	if rec, _, ok := s.openRunOfTool(toToolID); ok {
		return rec, true
	}
	if rec, _, ok := s.openRunOfTool(fromToolID); ok {
		return rec, true
	}
	return run.Record{}, false
}

// graphParty 는 toolId 를 그래프의 노드 이름으로 푼다 (FR-RVZ-14 의 From/To).
//
// 대상 Run 을 먼저 본다. 같은 도구가 다른 Run 의 조정자이면서 이 Run 의 멤버일 수
// 있고, 그때 이 Run 의 그래프에 찍혀야 하는 것은 멤버 uuid 다. 어느 Run 의
// 멤버도, 이 Run 의 조정자도 아니면 이름이 없다 — 팀 밖 통신이다.
func (s *Server) graphParty(rec run.Record, toolID string) (string, bool) {
	if toolID == "" {
		return "", false
	}
	for _, m := range rec.Members {
		if m.ToolID == toolID {
			return m.ID, true
		}
	}
	if toolID == rec.CoordinatorToolID {
		return run.CoordinatorParty, true
	}
	// 다른 Run 의 멤버는 자기 uuid 로 남는다. 그 노드는 이 그래프에 없지만,
	// 건너온 사실을 지우는 것보다 낫다 — 팀 사이의 통신은 조정자가 알아야 한다.
	if _, m, ok := s.openRunOfTool(toolID); ok {
		return m.ID, true
	}
	return "", false
}
