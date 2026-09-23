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
// 상태를 읽는 곳은 브라우저에 둘 있다 — dim 표시(applyFocusOverlay)와 PTY 리사이즈
// 권한 판정(resizeCheck). 둘은 같은 상태를 읽으므로 소유권 오판은 표시 문제가 아니라
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
	// prior maps a windowId to the identity that most recently **left** it —
	// displaced, released or detached alike (OWNER_HANDBACK_SRS FR-OHB-1·2).
	// 주인이 비는 순간 누가 채우는가의 답이며, `owners` 와 같은 수명이다
	// (비영속 — 서버 재시작은 둘 다 잊는다, FR-XDF-1).
	prior map[string]string
	// addrs maps a clientId to the remote address of its newest subscription.
	// 뷰어가 서버와 같은 컴퓨터인지 판정하는 근거다
	// (VIEWER_URL_OPEN_SRS FR-VUO-1). 모르면 빈 문자열이고, 그때는 원격으로
	// 취급된다 — 확인을 한 번 더 묻는 쪽이 안전하다.
	addrs map[string]string
}

func NewFocusRegistry() *FocusRegistry {
	return &FocusRegistry{owners: map[string]string{}, live: map[string]uint64{}, claimed: map[string]uint64{},
		prior: map[string]string{}, addrs: map[string]string{}}
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
			// 옮겨 가는 것도 떠나는 것이다 — 두고 가는 창은 같은 문을 지나고,
			// 거기서 직전 주인에게 돌아갈 수 있다 (FR-OHB-2).
			f.leaveLocked(wid, clientID)
			changed = true
		}
	}
	if f.owners[windowID] != clientID {
		// 밀려나는 주인을 직전 주인으로 적는다. **여기서는 돌려주지 않는다** —
		// 이 창은 지금 주장자의 것이 되므로 돌려줄 자리가 없다 (FR-XDF-2).
		if displaced := f.owners[windowID]; displaced != "" && displaced != clientID {
			f.prior[windowID] = displaced
		}
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

// Release drops every window owned by clientID **without ending its
// subscription** (UX_BATCH10_SRS FR-UXB-20~22 / D-UXB-3).
//
// blur 는 "떠났다" 가 아니라 "지금은 내 차례가 아니다" 이다. 해제(Detach)로
// 대신하면 SSE 가 끊겨 명령·이벤트가 멎고 실행자 후보에서도 빠진다 — 그래서
// `live`·`claimed`·`addrs` 는 그대로 두고 `owners` 만 준다.
//
// 이 동사가 없어서, 창을 빼앗은 화면이 포커스를 잃어도 소유권이 그대로 남았다.
// 빼앗긴 쪽은 영영 dim 인 채였다 (SRS §2.4).
//
// Reports whether anything changed — a no-op release produces no broadcast
// (FR-XDF-14 와 같은 멱등 규약).
func (f *FocusRegistry) Release(clientID string) bool {
	if clientID == "" {
		return false
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	changed := false
	for wid, owner := range f.owners {
		if owner == clientID {
			f.leaveLocked(wid, clientID)
			changed = true
		}
	}
	return changed
}

// leaveLocked 은 한 신원이 한 창을 **떠나는 유일한 자리**다 (FR-OHB-2).
//
// 떠남의 방식은 셋이다 — 밀려남·반납·해제. 셋이 같은 자리를 지나지 않으면 직전
// 주인의 기억이 경로마다 갈린다. 실측이 그것을 못박았다: A 가 **놓은 뒤에** B 가
// 빈 창을 가져갔으므로, 밀려남만 적는 구현은 그 사례를 영영 잡지 못한다
// (OWNER_HANDBACK_SRS §2.3 ①).
//
// 돌려줄 수 있으면 **같은 락 안에서** 돌려준다 (NFR-OHB-1). 놓기와 세우기를 두
// 단으로 나누면 그 사이의 Snapshot 이 "주인 없음" 을 보고 나간다.
func (f *FocusRegistry) leaveLocked(windowID, owner string) {
	prev := f.prior[windowID]
	f.prior[windowID] = owner
	delete(f.owners, windowID)
	// 자기 자신에게는 돌려주지 않는다 (FR-OHB-4) — 그러면 반납이 아무 일도 하지
	// 않는 동사가 된다.
	if prev == "" || prev == owner {
		return
	}
	if f.canTakeLocked(prev) {
		// 부르는 쪽 셋은 모두 `owners` 를 range 로 돌던 중이다. 여기서 다시 넣은
		// 항목이 그 순회에 실려 한 번 더 나올 수 있으나(Go 는 그것을 미정으로
		// 둔다), 새 주인은 **떠난 신원이 아니므로** 셋의 `owner == clientID`
		// 갈래에 걸리지 않는다. 다시 떠나지 않는다.
		f.owners[windowID] = prev
	}
}

// canTakeLocked 은 직전 주인이 창을 돌려받을 수 있는지 답한다.
//
//   - 구독이 살아 있어야 한다 (FR-OHB-7). 죽은 신원에게 돌려주면 그 창은 아무도
//     크기를 정하지 못하는 채로 잠긴다. **보이는지는 묻지 않는다** — 서버가 알
//     수 없고, 알리려면 와이어에 낡을 수 있는 사실이 하나 는다 (D-OHB-1).
//   - 다른 창을 쥐고 있지 않아야 한다 (FR-OHB-5 · FR-XDF-3). 뺏어 오면 그 창이
//     비고, 그 자리에서 또 돌려주기가 서며, 창이 고리를 이루면 끝나지 않는다.
func (f *FocusRegistry) canTakeLocked(clientID string) bool {
	if _, live := f.live[clientID]; !live {
		return false
	}
	for _, owner := range f.owners {
		if owner == clientID {
			return false
		}
	}
	return true
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
	return f.executorLocked()
}

// ExecutorAddr 은 뽑힌 뷰어와 그 구독의 원격 주소를 **한 락 안에서** 함께 낸다
// (FR-VUO-1). 둘로 나누어 물으면 그 사이에 뷰어가 떠나 다른 클라이언트의 주소로
// 판정할 수 있다. 구독이 없으면 둘 다 빈 문자열이다 (FR-VUO-4).
func (f *FocusRegistry) ExecutorAddr() (clientID, remoteAddr string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	cid := f.executorLocked()
	if cid == "" {
		return "", ""
	}
	return cid, f.addrs[cid]
}

func (f *FocusRegistry) executorLocked() string {
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
// LiveCount 는 지금 붙어 있는 구독 수다. 진단이 "뷰어가 없어서 로컬" 인지
// "뷰어가 있는데 로컬로 판정" 인지 구별하는 데 쓴다 (VIEWER_URL_OPEN_SRS FR-VUO-19).
func (f *FocusRegistry) LiveCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.live)
}

func (f *FocusRegistry) Attach(clientID string) uint64 { return f.AttachFrom(clientID, "") }

// AttachFrom 은 Attach 에 구독의 원격 주소를 함께 남긴다 (FR-VUO-1). 주소를
// 아는 호출자는 이쪽을 쓴다.
func (f *FocusRegistry) AttachFrom(clientID, remoteAddr string) uint64 {
	if clientID == "" {
		return 0
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.epoch++
	f.live[clientID] = f.epoch
	if remoteAddr != "" {
		f.addrs[clientID] = remoteAddr
	} else {
		delete(f.addrs, clientID)
	}
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
	delete(f.addrs, clientID)
	changed := false
	for wid, owner := range f.owners {
		if owner == clientID {
			// 구독이 끊긴 것도 떠난 것이다 — 상대 기기가 창을 닫는 것과 blur
			// 하는 것은 이쪽 화면에서 구별되지 않아야 한다 (FR-OHB-2·3).
			f.leaveLocked(wid, clientID)
			changed = true
		}
	}
	return changed
}
