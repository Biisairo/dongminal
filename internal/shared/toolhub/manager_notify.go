package toolhub

import (
	"sort"
	"time"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `manager.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **바깥에 알리는 일**이다 — 주의·활동·출력·종료·크기의 통보자와
// 그 배선. `manager.go` 에 남은 것은 도구의 수명이며, 통보자가 하나 더 늘어도
// 그 수명은 바뀌지 않는다.

// SetAttentionNotifier wires tool attention transitions to broadcasts. Called
// from the composition root after the CommandHub exists (mirrors
// SetInvalidator). Must be called before tools are created so Create/Restore
// hand the hooks to StartTool.
func (m *ToolManager) SetAttentionNotifier(notify func(id, reason string), clear func(id string)) {
	m.mu.Lock()
	m.attnNotify = notify
	m.attnClear = clear
	m.mu.Unlock()
}

// SetActivityNotifier wires tool activity transitions to broadcasts (mirrors
// SetAttentionNotifier). Must be called before tools are created.
func (m *ToolManager) SetActivityNotifier(notify func(id, state, tool, detail string)) {
	m.mu.Lock()
	m.activityNotify = notify
	m.mu.Unlock()
}

// attnHooks builds the per-tool hooks from the manager's notifier config.
// SetOutputObserver 는 모든 도구의 출력 청크를 받는 관측자를 꽂는다 (D-C-2) —
// 직접 모드의 에이전트 해석층이 그 자리다. 기동 전에 릴레이에 실리므로 이 뒤에
// 만들어진 도구만 받는다; 배선에서 LoadAll 앞에 한 번 부른다.
func (m *ToolManager) SetOutputObserver(f func(id string, kind ToolKind, data []byte, end int64)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.outputObserver = f
}

// SetExitObserver 는 도구의 죽음을 받는 관측자다 — 직접 모드의 에이전트 해석층이
// 세션을 오류·휴면 상태로 옮기는 자리 (D-C-2·D-C-15). info 는 종료 코드와 stderr 꼬리다.
// 데몬 모드의 짝은 ToolClient.SetOnExit.
func (m *ToolManager) SetExitObserver(f func(id string, info ExitInfo)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.exitObserver = f
}

// attnHooks 는 StartTool 이 거는 훅 묶음이다.
//
// **크기 통보는 주의 배선과 무관하게 언제나 실린다** (FR-M9-3) — 주의 훅이 하나도
// 없어도 PTY 크기는 말해야 한다. 그래서 이 함수는 더 이상 nil 을 돌려주지 않는다.
// 받는 쪽(`StartTool`)은 필드마다 nil 을 견디므로 빈 훅이 실리는 것은 무동작이다.
func (m *ToolManager) attnHooks() *ToolHooks {
	if m.attnNotify == nil && m.attnClear == nil && m.activityNotify == nil && m.outputObserver == nil {
		return &ToolHooks{OnSize: m.sizeNotify}
	}
	return &ToolHooks{OnAttention: m.attnNotify, OnAttentionClear: m.attnClear, OnActivity: m.activityNotify,
		AllowBell: m.allowBell, OnOutput: m.outputObserver, OnSize: m.sizeNotify}
}

// SetResizeNotifier 는 PTY 크기가 **바뀌었을 때만** 불리는 콜백을 건다
// (FR-M9-3). 데몬 모드에서는 PanedServer 가 이것을 IPC push 로 잇는다.
// 직접 모드는 걸지 않는다 — 그쪽의 통보는 `Tool.broadcast` 가 끝낸다.
func (m *ToolManager) SetResizeNotifier(notify func(id string, cols, rows uint16)) {
	m.szMu.Lock()
	m.szNotify = notify
	m.szMu.Unlock()
}

// sizeNotify 는 **호출 시점에** 걸려 있는 알림자에게 넘긴다. 도구가 뜰 때
// 알림자가 아직 없어도(데몬 연결 전) 나중에 걸린 것이 동작하는 이유다.
func (m *ToolManager) sizeNotify(id string, cols, rows uint16) {
	m.szMu.Lock()
	notify := m.szNotify
	m.szMu.Unlock()
	if notify != nil {
		notify(id, cols, rows)
	}
}

// ActivitySnapshot returns the current activity of every tool that has reported
// one, sorted by id (FR-AAP-4; lets a late-joining client restore cards).
func (m *ToolManager) ActivitySnapshot() []ActivitySnap {
	type item struct {
		id string
		a  *ActivityState
		p  *Tool
	}
	m.mu.RLock()
	items := make([]item, 0, len(m.tools))
	for id, p := range m.tools {
		if a := p.Activity(); a != nil {
			items = append(items, item{id, a, p})
		}
	}
	m.mu.RUnlock()
	// busy check (pgrep) runs outside the lock. A `working` card whose agent
	// process is gone is pruned so an abnormal exit (no Stop/SessionEnd hook)
	// doesn't leave a stale "working" (FR-AAP-20).
	out := []ActivitySnap{}
	for _, it := range items {
		if it.a.State == "working" && !attnBusyProbe(it.p) {
			continue
		}
		out = append(out, ActivitySnap{ToolID: it.id, State: it.a.State, Tool: it.a.Tool, Detail: it.a.Detail, UpdatedAt: it.a.UpdatedAt})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ToolID < out[j].ToolID })
	return out
}

// sweepIdle runs one L2 idle pass at the given time. Exposed for deterministic
// tests; the goroutine in StartAttentionSweeper calls it on each tick.
func (m *ToolManager) sweepIdle(now int64) {
	m.mu.RLock()
	tools := make([]*Tool, 0, len(m.tools))
	for _, p := range m.tools {
		tools = append(tools, p)
	}
	threshold := m.idleThreshold
	m.mu.RUnlock()
	for _, p := range tools {
		p.maybeIdle(now, threshold)
	}
}

// StartAttentionSweeper launches the L2 idle sweeper goroutine. stop closes on
// server shutdown. No-op when L2 is disabled (idleThreshold<=0).
//
// 틱은 주입한다 (M8 TEST-8) — 배선은 `AttentionSweepInterval` 티커의 채널을,
// 테스트는 자기 채널을 준다. 데몬 모드의 `hub.AttnTracker.StartSweeper` 와 같은
// 모양이다.
func (m *ToolManager) StartAttentionSweeper(stop <-chan struct{}, tick <-chan time.Time) {
	if m.idleThreshold <= 0 {
		return
	}
	go func() {
		for {
			select {
			case <-tick:
				m.sweepIdle(attnNow())
			case <-stop:
				return
			}
		}
	}()
}

// AttentionSweepInterval 은 배선이 스위퍼에 주는 틱의 주기다.
const AttentionSweepInterval = attnTickMS * time.Millisecond

// AttentionIDs returns the ids of tools currently needing attention (FR-PAN-8).
func (m *ToolManager) AttentionIDs() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	var ids []string
	for id, p := range m.tools {
		if p.Attention() {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// ClearAllAttention attends to every tool currently needing attention and
// returns how many were cleared (FR-PAN-17, bulk dismiss).
func (m *ToolManager) ClearAllAttention() int {
	m.mu.RLock()
	tools := make([]*Tool, 0, len(m.tools))
	for _, p := range m.tools {
		tools = append(tools, p)
	}
	m.mu.RUnlock()
	n := 0
	for _, p := range tools {
		if p.Attention() {
			p.Attend()
			n++
		}
	}
	return n
}

// SetOwnedTools registers the probe that answers "which tools belong to a live
// owner in a layer above this one" (FR-HLM-3).
//
// invalidator 와 같은 형태로 위에서 꽂는다 — toolhub 가 Run 을 import 하면 의존
// 방향이 뒤집힌다. 집합을 통째로 돌려주는 이유는 SaveAll 이 도구마다 묻지 않고
// 한 번만 묻게 하기 위해서다: 제공자가 파일을 읽을 수 있다.
func (m *ToolManager) SetOwnedTools(f func() map[string]struct{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ownedProvider = f
}

// ownedTools reads the probe under lock and calls it outside — 제공자가 파일
// I/O 를 할 수 있으므로 잠금을 건너 부르지 않는다 (Cwd() 와 같은 규약).
func (m *ToolManager) ownedTools() map[string]struct{} {
	m.mu.RLock()
	f := m.ownedProvider
	m.mu.RUnlock()
	if f == nil {
		return nil
	}
	return f()
}

// SetInvalidator lets main register the workspace invalidation hook after
// wsMgr has been constructed (avoids a chicken-and-egg ordering issue).
func (m *ToolManager) SetInvalidator(f func(string)) {
	m.mu.Lock()
	m.invalidator = f
	m.mu.Unlock()
}

// SetBackgroundChanged 는 백그라운드 목록 변화의 수신자를 꽂는다 (FR-BGP-2).
func (m *ToolManager) SetBackgroundChanged(f func()) {
	m.mu.Lock()
	m.bgChanged = f
	m.mu.Unlock()
}

// notifyBackground 는 수신자를 잠금 밖에서 부른다 — 수신자가 SSE 브로드캐스트를
// 하며, 그 안에서 다시 이 매니저를 물을 수 있다 (`BackgroundList`). 잠금을 쥔 채
// 부르면 그 자리에서 잠긴다.
func (m *ToolManager) notifyBackground() {
	m.mu.RLock()
	f := m.bgChanged
	m.mu.RUnlock()
	if f != nil {
		f()
	}
}
