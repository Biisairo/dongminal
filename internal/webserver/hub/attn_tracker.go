package hub

import (
	"dongminal/internal/shared/toolhub"

	"bytes"
	"sync"
	"sync/atomic"
	"time"
)

// AttnTracker manages per-tool attention and activity state in dongminal's
// memory. Used in daemon mode where toolhub.ToolManager lives in dongminald and
// dongminal needs its own attention/activity detection (DAEMON_SPLIT_SRS).
type AttnTracker struct {
	mu    sync.Mutex
	tools map[string]*attnPaneState
	hub   CommandBroker

	// L2 idle sweeper
	idleThreshold int64             // nanos, 0 disables
	busyProbe     func(string) bool // foreground-process check; nil → never idle

	// nowFn 은 이 추적기의 시계다 (ATTENTION_FIRING_SRS NFR-5). 굳은 `working`
	// 의 판정이 시각을 보므로, 테스트가 잠들지 않고 그 자리를 재려면 시계가
	// 주입 가능해야 한다.
	nowFn func() int64

	// liveProbe 는 "그 도구가 아직 있는가" 다 (FR-ATL-6). busyProbe 와 묻는 것이
	// 다르다 — 저쪽은 전경 프로세스, 이쪽은 도구 자체의 존재다. nil 이면 이
	// 필드가 없던 때와 완전히 같다.
	liveProbe func(string) bool

	// Output observation per tool
	onAttention      func(id, reason string)
	onAttentionClear func(id string)
	onActivity       func(id, state, tool, detail string)
}

// attnPaneState 는 직접 모드 `toolhub.Tool` 의 주의 관련 필드와 **같은 모양**을
// 갖는다 (FR-ATF-12·NFR-4). 두 모드의 판정이 갈라지지 않게 하려면 상태부터
// 갈라지지 않아야 한다.
type attnPaneState struct {
	id              string
	lastOutputAt    atomic.Int64
	attnArmed       atomic.Bool
	attention       atomic.Bool
	attnRearmLocked atomic.Bool // FR-ATF-5
	agentSeen       atomic.Bool // FR-ATF-1
	attnCarry       []byte
	allowBell       bool
	activity        atomic.Pointer[toolhub.ActivityState]
}

// DefaultIdleMS returns the L2 idle threshold in milliseconds, honoring the
// DONGMINAL_ATTENTION_IDLE_MS override. Daemon-mode wiring uses it so L2 idle
// behaves identically to direct mode (FR-15).
func DefaultIdleMS() int { return int(toolhub.AttentionIdleThreshold() / time.Millisecond) }

// NewAttnTracker creates an attention/activity tracker wired to the SSE hub.
func NewAttnTracker(hub CommandBroker, idleMS int) *AttnTracker {
	t := &AttnTracker{
		tools:         map[string]*attnPaneState{},
		hub:           hub,
		idleThreshold: int64(idleMS) * int64(time.Millisecond),
		nowFn:         func() int64 { return time.Now().UnixNano() },
	}
	t.onAttention = func(id, reason string) {
		hub.Broadcast(toolAttentionPayload(id, reason))
	}
	t.onAttentionClear = func(id string) {
		hub.Broadcast(toolAttentionClearPayload(id))
	}
	t.onActivity = func(id, state, tool, detail string) {
		hub.Broadcast(toolActivityPayload(id, state, tool, detail))
	}
	return t
}

// SetBusyProbe installs the foreground-process check used by the L2 idle
// sweeper. In daemon mode this is wired to toolclient.ToolClient.Busy (a busy RPC to
// dongminald). Without it, idle never fires (matching direct mode, where a
// bare prompt must not raise an alarm — DAEMON_SPLIT_SRS FR-15).
func (t *AttnTracker) SetBusyProbe(f func(string) bool) {
	t.mu.Lock()
	t.busyProbe = f
	t.mu.Unlock()
}

// SetLiveProbe installs the liveness check used by AttentionIDs (FR-ATL-6). In
// daemon mode this is wired to toolclient.ToolClient.IsLive. It is the second
// line of defence behind Forget: if a tool exit notice is ever missed, a dead
// tool's alarm still must not be restored to a joining browser.
func (t *AttnTracker) SetLiveProbe(f func(string) bool) {
	t.mu.Lock()
	t.liveProbe = f
	t.mu.Unlock()
}

// Forget drops a tool's tracked state entirely (FR-ATL-4). Called when the tool
// exits or is deleted. Attention is released first — and broadcast only on the
// edge (NFR-PAN-3) — so a browser holding the alarm hears about it; without
// this the map grew without bound and dead tools kept their badge.
func (t *AttnTracker) Forget(toolID string) {
	t.mu.Lock()
	ps := t.tools[toolID]
	delete(t.tools, toolID)
	onClear := t.onAttentionClear
	t.mu.Unlock()
	if ps == nil {
		return
	}
	if ps.attention.CompareAndSwap(true, false) && onClear != nil {
		onClear(toolID)
	}
}

// StartSweeper launches the L2 idle sweeper goroutine. stopCh closes on
// server shutdown.
//
// 멈추는 길은 stopCh 하나다 (FR-CAF-15). 종전에는 `Stop()` 과 `t.stop` 채널이
// 두 번째 길로 있었으나 아무도 부르지 않았고(그래서 `t.stop` 은 영영 닫히지
// 않는 갈래였다), 두 번 부르면 close 가 패닉하는 상태였다. 티커도 이 고루틴
// 밖에서 쓰이지 않으므로 구조체 필드로 둘 이유가 없다 — 필드로 두면 잠금 없이
// 공유되는 값이 하나 더 생긴다.
func (t *AttnTracker) StartSweeper(stopCh <-chan struct{}) {
	if t.idleThreshold <= 0 {
		return
	}
	go func() {
		tk := time.NewTicker(1 * time.Second)
		defer tk.Stop()
		for {
			select {
			case <-tk.C:
				t.sweepIdle()
			case <-stopCh:
				return
			}
		}
	}()
}

// FeedOutput processes raw PTY output for attention detection (L1 OSC).
// Called from handleWSDaemon when output arrives from dongminald.
func (t *AttnTracker) FeedOutput(toolID string, data []byte) {
	ps := t.state(toolID)

	ps.lastOutputAt.Store(t.now())
	// FR-ATF-5: 잠긴 동안 출력은 무장을 세우지 못한다. 시각은 그래도 적는다 —
	// 준비완료 사다리(FR-STA-4)가 그 값을 읽는다.
	if !ps.attnRearmLocked.Load() {
		ps.attnArmed.Store(true)
	}

	// L1 OSC detection
	scan := data
	if len(ps.attnCarry) > 0 {
		scan = append(append([]byte(nil), ps.attnCarry...), data...)
	}
	if bytes.IndexByte(scan, 0x1b) >= 0 || bytes.IndexByte(scan, 0x07) >= 0 {
		sig, carry := toolhub.DetectAttentionSignal(scan, ps.allowBell, toolhub.AttnMaxCarry)
		ps.attnCarry = carry
		if sig {
			if ps.attention.CompareAndSwap(false, true) {
				t.onAttention(toolID, "signaled")
			}
		}
	} else {
		ps.attnCarry = nil
	}
}

// SignalAttention sets attention explicitly (dmctl notify).
func (t *AttnTracker) SignalAttention(toolID, reason string) {
	ps := t.state(toolID)

	ps.attention.Store(true)
	if reason == "" {
		reason = "signaled"
	}
	t.onAttention(toolID, reason)
}

// Attend clears attention (user looked at the tool) and locks re-arming
// (FR-ATF-5) — mirrors toolhub.Tool.Attend.
func (t *AttnTracker) Attend(toolID string) { t.attend(toolID, false) }

// AttendTyped 는 사용자가 키를 누른 주목이다 (FR-ATF-6). 일을 시켰으므로 그
// 결과를 다시 기다리게 되고, 따라서 재무장을 열어 둔다.
func (t *AttnTracker) AttendTyped(toolID string) { t.attend(toolID, true) }

// attend 는 두 주목의 공통 자리다. 도구를 모르는 상태에서도 잠금 상태를 남겨야
// 하므로(해제가 SSE 보다 먼저 닿을 수 있다) 상태를 만들어 둔다.
func (t *AttnTracker) attend(toolID string, typed bool) {
	ps := t.state(toolID)
	ps.attnArmed.Store(false)
	ps.attnRearmLocked.Store(!typed)
	if ps.attention.CompareAndSwap(true, false) {
		t.onAttentionClear(toolID)
	}
}

// state 는 도구의 추적 상태를 얻는다(없으면 만든다). FeedOutput·SignalAttention·
// SetActivity·attend 가 모두 같은 규약을 쓰므로 한 자리에 둔다.
func (t *AttnTracker) state(toolID string) *attnPaneState {
	t.mu.Lock()
	defer t.mu.Unlock()
	ps := t.tools[toolID]
	if ps == nil {
		ps = &attnPaneState{id: toolID}
		t.tools[toolID] = ps
	}
	return ps
}

// now 는 주입된 시계를 읽는다 (NFR-5).
func (t *AttnTracker) now() int64 {
	t.mu.Lock()
	f := t.nowFn
	t.mu.Unlock()
	if f == nil {
		return time.Now().UnixNano()
	}
	return f()
}

// Attention returns whether the tool currently needs attention.
func (t *AttnTracker) Attention(toolID string) bool {
	t.mu.Lock()
	ps := t.tools[toolID]
	t.mu.Unlock()
	if ps == nil {
		return false
	}
	return ps.attention.Load()
}

// AttentionIDs returns all tool IDs currently needing attention. Dead tools are
// filtered out when a liveness probe is installed (FR-ATL-6); the probe (an RPC
// to dongminald) runs outside the lock.
func (t *AttnTracker) AttentionIDs() []string {
	t.mu.Lock()
	probe := t.liveProbe
	var ids []string
	for id, ps := range t.tools {
		if ps.attention.Load() {
			ids = append(ids, id)
		}
	}
	t.mu.Unlock()
	if probe == nil {
		return ids
	}
	out := ids[:0]
	for _, id := range ids {
		if probe(id) {
			out = append(out, id)
		}
	}
	return out
}

// ClearAllAttention clears attention for all tools (FR-PAN-17).
//
// FR-ATF-13: 정리는 도구 하나를 주목한 것과 **같다** — 무장을 내리고 재무장을
// 잠근다. 개정 전에는 주의 비트만 내려, 이미 임계 시간을 넘긴 도구들이 다음 1초
// tick 에서 통째로 되살아났다. 직접 모드는 처음부터 `Attend()` 를 지났으므로
// 이 결함이 없었다 (§2.4) — 두 모드가 갈라져 있던 자리다.
func (t *AttnTracker) ClearAllAttention() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := 0
	for _, ps := range t.tools {
		ps.attnArmed.Store(false)
		ps.attnRearmLocked.Store(true)
		if ps.attention.CompareAndSwap(true, false) {
			t.onAttentionClear(ps.id)
			n++
		}
	}
	return n
}

// SetActivity sets the activity state for a tool.
func (t *AttnTracker) SetActivity(toolID, state, tool, detail string) {
	ps := t.state(toolID)

	// FR-ATF-2: 보고했다는 사실이 에이전트 표시를 세우고, `ended` 가 내린다.
	ps.agentSeen.Store(state != "ended")
	if state == "ended" {
		ps.activity.Store(nil)
	} else {
		ps.activity.Store(&toolhub.ActivityState{
			State:     state,
			Tool:      tool,
			Detail:    detail,
			UpdatedAt: t.now(),
		})
	}
	t.onActivity(toolID, state, tool, detail)
}

// Activity returns the current activity state for a tool.
func (t *AttnTracker) Activity(toolID string) *toolhub.ActivityState {
	t.mu.Lock()
	ps := t.tools[toolID]
	t.mu.Unlock()
	if ps == nil {
		return nil
	}
	return ps.activity.Load()
}

// LastOutputAt returns the last observed output time for a tool in unix nanos,
// 0 when no output was ever observed. Feeds the tui-quiescence fallback of the
// readiness ladder (RUN_ORCHESTRATION_SRS FR-STA-4).
func (t *AttnTracker) LastOutputAt(toolID string) int64 {
	t.mu.Lock()
	ps := t.tools[toolID]
	t.mu.Unlock()
	if ps == nil {
		return 0
	}
	return ps.lastOutputAt.Load()
}

// ActivitySnapshot returns current activity for all tools. A "working" card
// whose foreground process is gone is pruned so an abnormal agent exit (no
// Stop/SessionEnd hook) doesn't leave a stale "working" card — parity with
// direct-mode toolhub.ToolManager.ActivitySnapshot (FR-AAP-20). The busy probe (an RPC
// to dongminald) runs outside the lock.
func (t *AttnTracker) ActivitySnapshot() []toolhub.ActivitySnap {
	t.mu.Lock()
	probe := t.busyProbe
	items := make([]toolhub.ActivitySnap, 0, len(t.tools))
	for id, ps := range t.tools {
		a := ps.activity.Load()
		if a == nil {
			continue
		}
		items = append(items, toolhub.ActivitySnap{
			ToolID:    id,
			State:     a.State,
			Tool:      a.Tool,
			Detail:    a.Detail,
			UpdatedAt: a.UpdatedAt,
		})
	}
	t.mu.Unlock()

	out := []toolhub.ActivitySnap{}
	for _, it := range items {
		if it.State == "working" && probe != nil && !probe(it.ToolID) {
			continue
		}
		out = append(out, it)
	}
	return out
}

// sweepIdle runs one L2 idle pass at the tracker's clock.
func (t *AttnTracker) sweepIdle() { t.SweepIdleAt(t.now()) }

// SweepIdleAt runs one L2 idle pass at the given time. 공개인 이유는 직접 모드의
// 대응물(`ToolManager.sweepIdle`)과 같다 — 결정적 테스트가 이 자리를 시계 없이
// 재야 하고, 데몬 모드에서는 그 테스트가 다른 패키지에 산다 (NFR-5).
//
// 판정의 순서와 뜻은 직접 모드 `Tool.maybeIdle` 과 **글자 그대로 같다**
// (FR-ATF-12): ① 에이전트가 도는 도구인가 ② 전경 프로세스가 있는가 ③ 지금
// 일하는 중은 아닌가(굳은 `working` 은 억제하지 못한다).
func (t *AttnTracker) SweepIdleAt(now int64) {
	t.mu.Lock()
	snap := make([]*attnPaneState, 0, len(t.tools))
	for _, ps := range t.tools {
		snap = append(snap, ps)
	}
	threshold := t.idleThreshold
	probe := t.busyProbe
	onAttn := t.onAttention
	t.mu.Unlock()

	if threshold <= 0 {
		return
	}
	for _, ps := range snap {
		if !ps.attnArmed.Load() {
			continue
		}
		if now-ps.lastOutputAt.Load() < threshold {
			continue
		}
		ps.attnArmed.Store(false)
		if !ps.agentSeen.Load() || probe == nil || !probe(ps.id) {
			continue
		}
		if toolhub.ActivityStillWorking(ps.activity.Load(), now) {
			continue
		}
		if ps.attention.CompareAndSwap(false, true) && onAttn != nil {
			onAttn(ps.id, "idle")
		}
	}
}
