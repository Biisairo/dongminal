package hub

import (
	"dongminal/internal/shared/toolipc"
)

// AGENT_RECORD_DAEMON_SRS 단계 3 — 데몬이 판정하면 추적기는 거울이다 (FR-ARD-30, §3.3a).
// 출력은 마지막 출력 시각만 남기고, 스위퍼와 데몬 되쓰기는 쉰다. 판정의 결과는 attn push
// 로 받아 반영하고 방송한다.

// SetMirror 는 "데몬이 판정하는가" 를 건다. 부를 때마다 묻는다 — 다시 붙은 데몬이 옛
// 판일 수 있다.
func (t *AttnTracker) SetMirror(f func() bool) { t.mirror.Store(&f) }

func (t *AttnTracker) mirroring() bool {
	f := t.mirror.Load()
	return f != nil && (*f)()
}

// ApplyAttn 은 데몬 판정의 결과 하나다. 상태를 되세운 뒤 kind 대로 방송한다. 데몬 RPC 를
// 하지 않으므로 읽기 루프에서 불러도 된다.
func (t *AttnTracker) ApplyAttn(ev toolipc.AttnEvent) {
	ps := t.state(ev.Tool)
	prev := ps.lastOutputAt.Load()
	ps.restore(ev.Agent)
	// 마지막 출력 시각은 서버도 출력을 보며 적는다. 늦게 온 push 가 뒤로 돌리지 않게 한다.
	if prev > ev.Agent.LastOutputAt {
		ps.lastOutputAt.Store(prev)
	}
	switch ev.Kind {
	case toolipc.AttnKindAttention:
		reason := ev.Reason
		if reason == "" {
			reason = "signaled"
		}
		t.onAttention(ev.Tool, reason)
	case toolipc.AttnKindClear:
		t.onAttentionClear(ev.Tool)
	case toolipc.AttnKindActivity:
		t.broadcastCard(ev.Tool, ev.Agent.Activity)
	}
}
