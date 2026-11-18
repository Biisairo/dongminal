package httpapi

import (
	"sync"
	"testing"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/hub"
)

// attnHooks는 주의 알림 이벤트를 슬라이스에 모으는 훅 묶음이다. 종단 핸들러
// 테스트가 알림 발화를 관찰하는 데 쓴다.
func attnHooks(mu *sync.Mutex, attn *[]string, clear *[]string) *toolhub.ToolHooks {
	return &toolhub.ToolHooks{
		OnAttention: func(pid, reason string) {
			mu.Lock()
			*attn = append(*attn, pid+":"+reason)
			mu.Unlock()
		},
		OnAttentionClear: func(pid string) {
			mu.Lock()
			*clear = append(*clear, pid)
			mu.Unlock()
		},
	}
}

// newAttnPane은 PTY 없이 주의 훅만 배선된 도구를 만든다. 도구 내부 동작 검증은
// toolhub 패키지의 동명 헬퍼가 담당하고, 여기 것은 종단 픽스처다.
func newAttnPane(id string, mu *sync.Mutex, attn *[]string, clear *[]string) *toolhub.Tool {
	return toolhub.NewDetachedTool(id, attnHooks(mu, attn, clear))
}

// newAttendingPane은 newAttnPane 과 같은 훅을 달고 주의 상태가 이미 올라간 도구를
// 만든다. armed 는 유휴 감시 무장 여부다.
func newAttendingPane(id string, mu *sync.Mutex, attn *[]string, clear *[]string, armed bool) *toolhub.Tool {
	return toolhub.NewAttendingTool(id, attnHooks(mu, attn, clear), armed)
}

// newActivityPane은 PTY 없이 활동 보고 훅만 배선된 도구를 만든다.
func newActivityPane(id string, mu *sync.Mutex, events *[]string) *toolhub.Tool {
	return toolhub.NewDetachedTool(id, &toolhub.ToolHooks{
		OnActivity: func(pid, state, tool, detail string) {
			mu.Lock()
			*events = append(*events, pid+":"+state+":"+tool+":"+detail)
			mu.Unlock()
		},
	})
}

// trackedTool 은 서버 추적기 위의 도구 하나다. 시험이 그 도구의 주의·활동을 묻고 세운다 —
// 관측은 추적기에 있다 (DIRECT_MODE_REMOVAL_SRS FR-DMR-12).
type trackedTool struct {
	id string
	tr *hub.AttnTracker
}

func (p trackedTool) Attention() bool                  { return p.tr.Attention(p.id) }
func (p trackedTool) Attend()                          { p.tr.Attend(p.id) }
func (p trackedTool) SignalAttention(reason string)    { p.tr.SignalAttention(p.id, reason) }
func (p trackedTool) Activity() *toolhub.ActivityState { return p.tr.Activity(p.id) }

// trackedServer 는 데몬에 붙고 추적기를 가진 서버다. ids 의 도구를 데몬에 들인다.
func trackedServer(t *testing.T, ids ...string) (*Server, *toolhub.ToolManager, *hub.AttnTracker) {
	t.Helper()
	m, mHub := daemonPairAt(t, "")
	for _, id := range ids {
		m.Adopt(toolhub.NewDetachedTool(id, nil))
	}
	tr := hub.NewAttnTracker(hub.NewCommandHub(), 0)
	return &Server{Deps: Deps{Tools: mHub, AttnTracker: tr}, limits: defaultLimits()}, m, tr
}
