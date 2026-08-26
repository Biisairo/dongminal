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
	ticker        *time.Ticker
	stop          chan struct{}

	// Output observation per tool
	onAttention      func(id, reason string)
	onAttentionClear func(id string)
	onActivity       func(id, state, tool, detail string)
}

type attnPaneState struct {
	id           string
	lastOutputAt atomic.Int64
	attnArmed    atomic.Bool
	attention    atomic.Bool
	attnCarry    []byte
	allowBell    bool
	activity     atomic.Pointer[toolhub.ActivityState]
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
		stop:          make(chan struct{}),
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

// StartSweeper launches the L2 idle sweeper goroutine. stopCh closes on
// server shutdown.
func (t *AttnTracker) StartSweeper(stopCh <-chan struct{}) {
	if t.idleThreshold <= 0 {
		return
	}
	t.ticker = time.NewTicker(1 * time.Second)
	go func() {
		defer t.ticker.Stop()
		for {
			select {
			case <-t.ticker.C:
				t.sweepIdle()
			case <-stopCh:
				return
			case <-t.stop:
				return
			}
		}
	}()
}

// Stop shuts down the sweeper.
func (t *AttnTracker) Stop() {
	close(t.stop)
}

// FeedOutput processes raw PTY output for attention detection (L1 OSC).
// Called from handleWSDaemon when output arrives from dongminald.
func (t *AttnTracker) FeedOutput(toolID string, data []byte) {
	t.mu.Lock()
	ps := t.tools[toolID]
	if ps == nil {
		ps = &attnPaneState{id: toolID}
		t.tools[toolID] = ps
	}
	t.mu.Unlock()

	now := time.Now().UnixNano()
	ps.lastOutputAt.Store(now)
	ps.attnArmed.Store(true)

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
	t.mu.Lock()
	ps := t.tools[toolID]
	if ps == nil {
		ps = &attnPaneState{id: toolID}
		t.tools[toolID] = ps
	}
	t.mu.Unlock()

	ps.attention.Store(true)
	if reason == "" {
		reason = "signaled"
	}
	t.onAttention(toolID, reason)
}

// Attend clears attention (user focus).
func (t *AttnTracker) Attend(toolID string) {
	t.mu.Lock()
	ps := t.tools[toolID]
	t.mu.Unlock()
	if ps == nil {
		return
	}
	ps.attnArmed.Store(false)
	if ps.attention.CompareAndSwap(true, false) {
		t.onAttentionClear(toolID)
	}
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

// AttentionIDs returns all tool IDs currently needing attention.
func (t *AttnTracker) AttentionIDs() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var ids []string
	for id, ps := range t.tools {
		if ps.attention.Load() {
			ids = append(ids, id)
		}
	}
	return ids
}

// ClearAllAttention clears attention for all tools.
func (t *AttnTracker) ClearAllAttention() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := 0
	for _, ps := range t.tools {
		if ps.attention.CompareAndSwap(true, false) {
			t.onAttentionClear(ps.id)
			n++
		}
	}
	return n
}

// SetActivity sets the activity state for a tool.
func (t *AttnTracker) SetActivity(toolID, state, tool, detail string) {
	t.mu.Lock()
	ps := t.tools[toolID]
	if ps == nil {
		ps = &attnPaneState{id: toolID}
		t.tools[toolID] = ps
	}
	t.mu.Unlock()

	if state == "ended" {
		ps.activity.Store(nil)
	} else {
		ps.activity.Store(&toolhub.ActivityState{
			State:     state,
			Tool:      tool,
			Detail:    detail,
			UpdatedAt: time.Now().UnixNano(),
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

// sweepIdle runs one L2 idle pass.
func (t *AttnTracker) sweepIdle() {
	now := time.Now().UnixNano()
	t.mu.Lock()
	snap := make([]*attnPaneState, 0, len(t.tools))
	for _, ps := range t.tools {
		snap = append(snap, ps)
	}
	t.mu.Unlock()

	t.mu.Lock()
	threshold := t.idleThreshold
	probe := t.busyProbe
	t.mu.Unlock()
	for _, ps := range snap {
		if !ps.attnArmed.Load() {
			continue
		}
		if now-ps.lastOutputAt.Load() < threshold {
			continue
		}
		ps.attnArmed.Store(false)
		// Idle only fires when a foreground process is actually running (an
		// agent waiting on the user); a bare shell at its prompt must not raise
		// an alarm. Mirrors direct-mode toolhub.Tool.maybeIdle (FR-15).
		if probe == nil || !probe(ps.id) {
			continue
		}
		// Suppress idle alarm while agent is actively working (thinking).
		if a := ps.activity.Load(); a != nil && a.State == "working" {
			continue
		}
		if ps.attention.CompareAndSwap(false, true) {
			onAttn := t.onAttention
			if onAttn != nil {
				onAttn(ps.id, "idle")
			}
		}
	}
}
