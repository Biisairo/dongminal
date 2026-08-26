package hub

import (
	"sync"
)

// Window focus ownership (USER_CHECKLIST_FIXES_SRS §3.5, FR-XDF-*).
//
// 한 Window 를 어느 Client 가 보고 있는지를 서버가 권위로 들고 있다. 이전 구현은
// 브라우저의 BroadcastChannel('dongminal-focus') 이었고, 그것은 동일 브라우저·동일
// origin 한정이라 다른 기기와 통신할 수 없었다 (SRS §2.7).
//
// 상태를 읽는 곳은 브라우저에 둘 있다 — dim 표시(_applyFocusOverlay)와 PTY 리사이즈
// 권한 판정(_resizeCheck). 둘은 같은 상태를 읽으므로 소유권 오판은 표시 문제가 아니라
// 터미널 크기 결정 문제다 (FR-XDF-4).

// FocusRegistry holds window→client ownership in memory. It is never persisted:
// client ownership is volatile and a server restart releases everyone (FR-XDF-1).
type FocusRegistry struct {
	mu     sync.Mutex
	owners map[string]string // windowId → clientId
	// live maps a clientId to the epoch of its newest SSE subscription. A
	// subscription may only release ownership if it is still the newest one —
	// otherwise a reconnect's claim is undone by the old connection's late
	// teardown (FR-XDF-10).
	live  map[string]uint64
	epoch uint64
	// claimed maps a clientId to the sequence number of its newest focus
	// claim. It is the executor election's notion of "the person currently
	// working" (WORKSPACE_IDENTITY_SRS FR-SXE-4).
	claimed  map[string]uint64
	claimSeq uint64
}

func NewFocusRegistry() *FocusRegistry {
	return &FocusRegistry{owners: map[string]string{}, live: map[string]uint64{}, claimed: map[string]uint64{}}
}

// Snapshot returns a copy of the current ownership map (FR-XDF-7).
func (f *FocusRegistry) Snapshot() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string]string, len(f.owners))
	for k, v := range f.owners {
		out[k] = v
	}
	return out
}

// Claim makes clientId the owner of windowId, releasing any other window that
// client owned — one client owns at most one window (FR-XDF-3). Ownership is
// last-focus-wins: an existing owner is displaced without negotiation
// (FR-XDF-2). Reports whether anything changed, so a no-op claim does not
// produce a broadcast.
func (f *FocusRegistry) Claim(clientID, windowID string) bool {
	if clientID == "" || windowID == "" {
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	changed := false
	for wid, owner := range f.owners {
		if wid != windowID && owner == clientID {
			delete(f.owners, wid)
			changed = true
		}
	}
	if f.owners[windowID] != clientID {
		f.owners[windowID] = clientID
		changed = true
	}
	// 변화가 있을 때만 최신성을 갱신한다. 같은 주장의 반복은 브로드캐스트를
	// 만들지 않으므로(FR-XDF-14) 실행자 순서도 바꾸지 않는 것이 일관된다.
	if changed {
		f.claimSeq++
		f.claimed[clientID] = f.claimSeq
	}
	return changed
}

// Executor names the single Client that should perform a creating command
// (FR-SXE-4). Candidates are live subscriptions only; among them the most
// recent focus claimer wins, falling back to the oldest subscription when no
// live client has ever claimed. Returns "" when nothing is subscribed, which
// FR-SXE-5 treats as "do not gate".
//
// "가장 오래된 구독" 만으로 정하면 다른 기기에 잊힌 배경 탭이 영구 실행자가 되어
// location 없는 생성 명령이 사람이 보고 있지 않은 곳에 쌓인다.
func (f *FocusRegistry) Executor() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	best, bestClaim := "", uint64(0)
	for cid := range f.live {
		if c := f.claimed[cid]; c > bestClaim {
			best, bestClaim = cid, c
		}
	}
	if best != "" {
		return best
	}
	oldest := uint64(0)
	for cid, ep := range f.live {
		if oldest == 0 || ep < oldest {
			best, oldest = cid, ep
		}
	}
	return best
}

// Attach registers a live subscription for clientID and returns its epoch. The
// epoch is the token Detach must present; a newer Attach supersedes older ones.
func (f *FocusRegistry) Attach(clientID string) uint64 {
	if clientID == "" {
		return 0
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.epoch++
	f.live[clientID] = f.epoch
	return f.epoch
}

// Detach releases every window owned by clientID, but only when ep is still the
// client's newest subscription (FR-XDF-10). There is no grace period: the
// subscription ending IS the release (FR-XDF-9). Reports whether anything changed.
func (f *FocusRegistry) Detach(clientID string, ep uint64) bool {
	if clientID == "" || ep == 0 {
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.live[clientID] != ep {
		return false // a newer subscription owns this client's identity
	}
	delete(f.live, clientID)
	delete(f.claimed, clientID)
	changed := false
	for wid, owner := range f.owners {
		if owner == clientID {
			delete(f.owners, wid)
			changed = true
		}
	}
	return changed
}
