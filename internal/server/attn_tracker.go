package server

import (
	"bytes"
	"sync"
	"sync/atomic"
	"time"
)

// AttnTracker manages per-pane attention and activity state in dongminal's
// memory. Used in daemon mode where PaneManager lives in dongminald and
// dongminal needs its own attention/activity detection (DAEMON_SPLIT_SRS).
type AttnTracker struct {
	mu    sync.Mutex
	panes map[string]*attnPaneState
	hub   CommandBroker

	// L2 idle sweeper
	idleThreshold int64             // nanos, 0 disables
	busyProbe     func(string) bool // foreground-process check; nil → never idle
	ticker        *time.Ticker
	stop          chan struct{}

	// Output observation per pane
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
	activity     atomic.Pointer[activityState]
}

// DefaultIdleMS returns the L2 idle threshold in milliseconds, honoring the
// DONGMINAL_ATTENTION_IDLE_MS override. Daemon-mode wiring uses it so L2 idle
// behaves identically to direct mode (FR-15).
func DefaultIdleMS() int { return int(attentionIdleThreshold() / time.Millisecond) }

// NewAttnTracker creates an attention/activity tracker wired to the SSE hub.
func NewAttnTracker(hub CommandBroker, idleMS int) *AttnTracker {
	t := &AttnTracker{
		panes:         map[string]*attnPaneState{},
		hub:           hub,
		idleThreshold: int64(idleMS) * int64(time.Millisecond),
		stop:          make(chan struct{}),
	}
	t.onAttention = func(id, reason string) {
		hub.Broadcast(paneAttentionPayload(id, reason))
	}
	t.onAttentionClear = func(id string) {
		hub.Broadcast(paneAttentionClearPayload(id))
	}
	t.onActivity = func(id, state, tool, detail string) {
		hub.Broadcast(paneActivityPayload(id, state, tool, detail))
	}
	return t
}

// SetBusyProbe installs the foreground-process check used by the L2 idle
// sweeper. In daemon mode this is wired to PaneClient.Busy (a busy RPC to
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
func (t *AttnTracker) FeedOutput(paneID string, data []byte) {
	t.mu.Lock()
	ps := t.panes[paneID]
	if ps == nil {
		ps = &attnPaneState{id: paneID}
		t.panes[paneID] = ps
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
		sig, carry := detectAttentionSignal(scan, ps.allowBell, attnMaxCarry)
		ps.attnCarry = carry
		if sig {
			if ps.attention.CompareAndSwap(false, true) {
				t.onAttention(paneID, "signaled")
			}
		}
	} else {
		ps.attnCarry = nil
	}
}

// SignalAttention sets attention explicitly (dmctl notify).
func (t *AttnTracker) SignalAttention(paneID, reason string) {
	t.mu.Lock()
	ps := t.panes[paneID]
	if ps == nil {
		ps = &attnPaneState{id: paneID}
		t.panes[paneID] = ps
	}
	t.mu.Unlock()

	ps.attention.Store(true)
	if reason == "" {
		reason = "signaled"
	}
	t.onAttention(paneID, reason)
}

// Attend clears attention (user focus).
func (t *AttnTracker) Attend(paneID string) {
	t.mu.Lock()
	ps := t.panes[paneID]
	t.mu.Unlock()
	if ps == nil {
		return
	}
	ps.attnArmed.Store(false)
	if ps.attention.CompareAndSwap(true, false) {
		t.onAttentionClear(paneID)
	}
}

// Attention returns whether the pane currently needs attention.
func (t *AttnTracker) Attention(paneID string) bool {
	t.mu.Lock()
	ps := t.panes[paneID]
	t.mu.Unlock()
	if ps == nil {
		return false
	}
	return ps.attention.Load()
}

// AttentionIDs returns all pane IDs currently needing attention.
func (t *AttnTracker) AttentionIDs() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var ids []string
	for id, ps := range t.panes {
		if ps.attention.Load() {
			ids = append(ids, id)
		}
	}
	return ids
}

// ClearAllAttention clears attention for all panes.
func (t *AttnTracker) ClearAllAttention() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	n := 0
	for _, ps := range t.panes {
		if ps.attention.CompareAndSwap(true, false) {
			t.onAttentionClear(ps.id)
			n++
		}
	}
	return n
}

// SetActivity sets the activity state for a pane.
func (t *AttnTracker) SetActivity(paneID, state, tool, detail string) {
	t.mu.Lock()
	ps := t.panes[paneID]
	if ps == nil {
		ps = &attnPaneState{id: paneID}
		t.panes[paneID] = ps
	}
	t.mu.Unlock()

	if state == "ended" {
		ps.activity.Store(nil)
	} else {
		ps.activity.Store(&activityState{
			State:     state,
			Tool:      tool,
			Detail:    detail,
			UpdatedAt: time.Now().UnixNano(),
		})
	}
	t.onActivity(paneID, state, tool, detail)
}

// Activity returns the current activity state for a pane.
func (t *AttnTracker) Activity(paneID string) *activityState {
	t.mu.Lock()
	ps := t.panes[paneID]
	t.mu.Unlock()
	if ps == nil {
		return nil
	}
	return ps.activity.Load()
}

// ActivitySnapshot returns current activity for all panes. A "working" card
// whose foreground process is gone is pruned so an abnormal agent exit (no
// Stop/SessionEnd hook) doesn't leave a stale "working" card — parity with
// direct-mode PaneManager.ActivitySnapshot (FR-AAP-20). The busy probe (an RPC
// to dongminald) runs outside the lock.
func (t *AttnTracker) ActivitySnapshot() []activitySnap {
	t.mu.Lock()
	probe := t.busyProbe
	items := make([]activitySnap, 0, len(t.panes))
	for id, ps := range t.panes {
		a := ps.activity.Load()
		if a == nil {
			continue
		}
		items = append(items, activitySnap{
			PaneID:    id,
			State:     a.State,
			Tool:      a.Tool,
			Detail:    a.Detail,
			UpdatedAt: a.UpdatedAt,
		})
	}
	t.mu.Unlock()

	out := []activitySnap{}
	for _, it := range items {
		if it.State == "working" && probe != nil && !probe(it.PaneID) {
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
	snap := make([]*attnPaneState, 0, len(t.panes))
	for _, ps := range t.panes {
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
		// an alarm. Mirrors direct-mode Pane.maybeIdle (FR-15).
		if probe == nil || !probe(ps.id) {
			continue
		}
		if ps.attention.CompareAndSwap(false, true) {
			t.onAttention(ps.id, "idle")
		}
	}
}
