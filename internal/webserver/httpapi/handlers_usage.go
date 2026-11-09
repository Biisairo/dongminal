package httpapi

import (
	"net/http"
	"sync"
	"time"

	"dongminal/internal/shared/statusline"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/run"
)

// ISSUE_AGENT_TREE_SRS 묶음 S — 도구별 사용량 (FR-SLP-10·11·20).
//
// `dmctl statusline`(프록시)이 Claude Code 의 statusLine 입력에서 꺼낸 값을 보낸다.
// 받는 꼴은 **타입으로 고정한 허용 목록**(statusline.Usage)이다 — 모르는 필드는 디코딩에서 떨어지므로
// 경로나 본문이 섞여 와도 저장되지 않는다 (FR-SLP-2a). 메모리에만 둔다: 사용량은
// 지금의 사실이고, 서버를 다시 띄우면 다음 statusLine 갱신이 다시 채운다.

// toolUsage 는 저장하는 관측 하나다. 허용 목록은 statusline.Usage 한 벌이고(`dmctl
// statusline` 이 같은 타입을 채워 보낸다), 여기서는 받은 시각만 더한다.
type toolUsage struct {
	statusline.Usage
	ObservedAt int64 `json:"observedAt"`
}

// contextTokens 는 지금 맥락에 든 토큰이다 — 입력·캐시 생성·캐시 읽기의 합
// (claudeParseUsage 와 같은 셈). 출력은 다음 요청의 입력이 되기 전까지 맥락이 아니다.
func (u *toolUsage) contextTokens() (float64, bool) {
	if u.ContextWindow == nil || u.ContextWindow.CurrentUsage == nil {
		return 0, false
	}
	c := u.ContextWindow.CurrentUsage
	sum, any := 0.0, false
	for _, v := range []*float64{c.InputTokens, c.CacheCreationInputTokens, c.CacheReadInputTokens} {
		if v != nil {
			sum += *v
			any = true
		}
	}
	return sum, any
}

// toolContext 는 `dmctl status` 의 `context` 다 (FR-SLP-20).
type toolContext struct {
	UsedPct      *float64 `json:"usedPct,omitempty"`
	WindowTokens float64  `json:"windowTokens,omitempty"`
	Tokens       float64  `json:"tokens,omitempty"`
	Source       string   `json:"source"`
	ObservedAt   int64    `json:"observedAt"`
}

const (
	contextSourceStatusLine = "statusline"
	contextSourceTranscript = "transcript"
)

type usageStore struct {
	mu sync.Mutex
	m  map[string]toolUsage
}

func (u *usageStore) put(toolID string, v toolUsage) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.m == nil {
		u.m = map[string]toolUsage{}
	}
	u.m[toolID] = v
}

func (u *usageStore) get(toolID string) (toolUsage, bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	v, ok := u.m[toolID]
	return v, ok
}

// prune 은 live 가 거짓인 도구의 사용량을 지우고 지운 수를 돌려준다. 도구가 죽어도
// 이 저장소에 알리는 자리가 없으므로 수거 루프(StartRunReaper)가 주기적으로 부른다.
func (u *usageStore) prune(live func(toolID string) bool) int {
	u.mu.Lock()
	defer u.mu.Unlock()
	n := 0
	for id := range u.m {
		if !live(id) {
			delete(u.m, id)
			n++
		}
	}
	return n
}

// apiToolUsage implements POST /api/tools/usage (FR-SLP-10).
func (s *Server) apiToolUsage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ToolID string    `json:"toolId"`
		Usage  toolUsage `json:"usage"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	toolID := s.callerToolID(r, body.ToolID)
	if toolID == "" {
		httpErr(w, "toolId required", http.StatusBadRequest, apierr.CodeMissingArg)
		return
	}
	u := body.Usage
	u.ObservedAt = time.Now().UnixMilli()
	s.usage.put(toolID, u)
	s.observeUsageContext(toolID, &u)
	writeJSON(w, map[string]any{"ok": true})
}

// observeUsageContext 는 Run 의 맥락 기록에도 공식 값을 넣는다 (FR-SLP-11·22).
func (s *Server) observeUsageContext(toolID string, u *toolUsage) {
	if s.Runs == nil || !s.Runs.HasOpen() {
		return
	}
	tokens, ok := u.contextTokens()
	if !ok {
		return
	}
	obs := run.ContextObservation{Tokens: int64(tokens), HasTokens: true}
	if u.ContextWindow.WindowTokens != nil {
		obs.Window = *u.ContextWindow.WindowTokens
	}
	if u.SessionID != nil {
		obs.SessionID = *u.SessionID
	}
	m, entered, found := s.Runs.ObserveContext(toolID, obs, s.contextPolicy())
	if found && entered != "" {
		s.notifyContextAlert(m, entered)
	}
}

// toolUsageView 는 상태 응답에 얹을 `context`·`usage` 다. statusLine 값이 없으면
// Run 기록의 transcript 값으로 `context` 만 채운다 (FR-SLP-11).
func (s *Server) toolUsageView(toolID string) (*toolContext, *toolUsage) {
	if u, ok := s.usage.get(toolID); ok {
		c := &toolContext{Source: contextSourceStatusLine, ObservedAt: u.ObservedAt}
		if cw := u.ContextWindow; cw != nil {
			c.UsedPct = cw.UsedPct
			if cw.WindowTokens != nil {
				c.WindowTokens = *cw.WindowTokens
			}
		}
		if t, ok := u.contextTokens(); ok {
			c.Tokens = t
		}
		return c, &u
	}
	if s.Runs == nil {
		return nil, nil
	}
	m, ok := s.Runs.MemberByTool(toolID)
	if !ok || m.ContextTokens <= 0 {
		return nil, nil
	}
	pct := m.ContextRatio * 100
	return &toolContext{UsedPct: &pct, WindowTokens: m.ContextLimit, Tokens: float64(m.ContextTokens),
		Source: contextSourceTranscript, ObservedAt: m.ContextAt}, nil
}

// cardUsage 는 활동 목록 항목의 사용량 요약이다 (ACTIVITY_CARD_USAGE_SRS FR-ACU-2).
// 카드가 그리는 값만 싣는다 — 경로·세션 id·비용은 여기 없다 (FR-ACU-5).
type cardUsage struct {
	CtxPct   *float64 `json:"ctxPct,omitempty"`
	CtxLevel string   `json:"ctxLevel,omitempty"`
	Model    string   `json:"model,omitempty"`
	Effort   string   `json:"effort,omitempty"`
}

// cardUsageOf 는 toolUsageView 의 두 값에서 요약을 만든다. 실을 값이 없으면 nil 이다
// (FR-ACU-4). 등급 경계는 맥락 정책의 것이다 (FR-ACU-3, D-ACU-2).
func cardUsageOf(c *toolContext, u *toolUsage, p run.ContextPolicy) *cardUsage {
	var out cardUsage
	if c != nil && c.UsedPct != nil {
		pct := *c.UsedPct
		out.CtxPct = &pct
		out.CtxLevel = p.Grade(pct/100, 0)
	}
	if u != nil {
		if m := u.Model; m != nil {
			switch {
			case m.DisplayName != nil && *m.DisplayName != "":
				out.Model = *m.DisplayName
			case m.ID != nil:
				out.Model = *m.ID
			}
		}
		if u.Effort != nil {
			out.Effort = *u.Effort
		}
	}
	if out == (cardUsage{}) {
		return nil
	}
	return &out
}

// activityEntry 는 `GET /api/tools/activity` 의 항목이다. 기존 필드는 ActivitySnap 그대로다 (FR-ACU-1).
type activityEntry struct {
	toolhub.ActivitySnap
	Usage *cardUsage `json:"usage,omitempty"`
	// SUBAGENT_USAGE_SRS FR-SAU-13: 신선한 서브에이전트 목록이 비어 있지 않을 때만 선다.
	Subagents []cardSubagent `json:"subagents,omitempty"`
}

func (s *Server) activityEntries() []activityEntry {
	snap := s.attention().ActivitySnapshot()
	out := make([]activityEntry, 0, len(snap))
	p := s.contextPolicy()
	now := time.Now()
	for _, a := range snap {
		c, u := s.toolUsageView(a.ToolID)
		subs, _ := s.subagents.get(a.ToolID, now)
		out = append(out, activityEntry{ActivitySnap: a, Usage: cardUsageOf(c, u, p), Subagents: cardSubagentsOf(subs, p)})
	}
	return out
}
