package hub

import (
	"strings"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/domain/git/store"
)

// 관심 표명·임차·축출 (FR-GPO-10~12 · GIT_WATCH_LEASE_SRS FR-GWL-1~8).

/*
Note 는 **관심 표명**이다 (FR-GPO-10).

브라우저가 `/api/git/status` 를 부르면 그 저장소가 감시 대상에 들어간다.

임차인을 밝히지 않은 표명이며 수명은 `ttl` 이다. 밝히는 쪽은 `NoteFor` 다 —
그 차이가 GIT_WATCH_LEASE_SRS 의 전부다.

`Store` 의 경계를 지킨다 (C-3): 폴링도 표명도 Store 에 넣지 않는다. Store 는
"물음이 겹칠 때 git 을 아끼는 일" 만 하고, 무엇을 언제 물을지는 여전히 밖에서
정한다.
*/
func (w *GitWatcher) Note(repo string, obs store.Observation) {
	w.NoteFor(repo, obs, "")
}

/*
NoteFor 는 **임차인을 밝힌 표명**이다 (GIT_WATCH_LEASE_SRS FR-GWL-1).

종전에는 표명의 수명이 `ttl` 하나였고 그것을 갱신하는 유일한 경로가 브라우저의
안전망 폴링이었다. 그래서 **안전망을 끄면 본줄인 push 가 함께 죽었다** — 사용자가
요청을 줄이려고 고른 설정이 자동 갱신을 통째로 끈 것이다 (11-git-polling GP-1).

`clientID` 의 SSE 구독이 살아 있으면 그 신원을 임차인으로 세운다. 임차인이 있는
동안에는 유휴 시간으로 만료되지 않는다 (FR-GWL-2) — 사용자는 Repo 창을 띄워 두고
터미널에서 작업하다 이따금 볼 수 있고, 그동안 갱신이 죽어 있으면 안 된다.

구독이 없는 신원은 임차인이 될 수 없다 (FR-GWL-8). "보고 있다" 를 주장하려면
보고 있는 연결이 있어야 하고, 그 연결이 끊기는 것이 곧 해제다.
*/
func (w *GitWatcher) NoteFor(repo string, obs store.Observation, clientID string) {
	w.NoteScoped(repo, obs, clientID, "")
}

// holderScopeSep 는 임차인 키에서 신원과 갈래를 가른다. clientId 에 들 수 없는 글자다.
const holderScopeSep = "\x1f"

func holderKey(clientID, scope string) string {
	if scope == "" {
		return clientID
	}
	return clientID + holderScopeSep + scope
}

/*
NoteScoped 는 **갈래를 가진 임대**다 (OPTIMIZE_REFACTOR_SRS FR-OPT-4-3 · IPC-7).

Repo 탭은 핀 전부를 한꺼번에 임대하고, 탭을 떠나면 그것을 한꺼번에 놓는다
(`ReleaseScope`). 같은 신원이 Git 패널의 status 로 쥔 임대(갈래 "")는 그와 별개로
남아야 하므로 임차인 키를 갈래로 가른다. 수명 규약은 `NoteFor` 와 같다 — 구독이
살아 있는 신원만 임차인이 되고, 구독이 끊기면 모든 갈래가 함께 풀린다.
*/
func (w *GitWatcher) NoteScoped(repo string, obs store.Observation, clientID, scope string) {
	if w == nil || repo == "" {
		return
	}
	w.mu.Lock()
	now := w.now()
	mark := obsMark(obs)
	// 구독이 살아 있는 신원만 임차인이 된다.
	ep := w.live[clientID]
	holder := holderKey(clientID, scope)
	if clientID == "" || ep == 0 {
		holder = ""
	}
	if e, ok := w.watch[repo]; ok {
		e.seenAt = now
		if holder != "" {
			e.holders[holder] = ep
		}
		// **기준선을 여기서 갱신하지 않는다.** 브라우저가 받은 관측과 감시자가
		// 마지막으로 알린 관측은 같은 것이고, 다르다면 그 차이는 이미 방송으로
		// 나갔다. 여기서 덮으면 그 방송과 이 응답 사이에 생긴 변화를 잃는다.
		w.mu.Unlock()
		return
	}
	// **첫 표명은 기준선을 함께 받는다.**
	//
	// 이것이 없으면 표명과 첫 회차 사이의 변화를 놓친다: `Note` 뒤 첫 `Tick` 이
	// 그때의 관측을 기준선으로 삼으므로, 그 사이에 생긴 변화가 기준선에 섞여
	// 들어가 "바뀐 적 없는" 것이 된다. e2e 가 그 자리를 잡았다 — 창을 열자마자
	// 파일을 만들면 화면이 30초(안전망)까지 낡은 채였다.
	//
	// 브라우저는 방금 이 관측을 응답으로 받았다. 그러므로 이 값이 곧 "브라우저가
	// 아는 상태" 이고, 기준선으로 정확하다.
	e := &gitWatchEntry{
		seenAt: now, lastMark: mark, hasMark: true,
		// 기준선은 방금 브라우저가 받은 관측의 것이다 — signature 도 그것을 쓴다.
		lastSig: obs.Signature.Value, hasSig: obs.Signature.Value != "",
		phase:   phaseHash(repo),
		holders: map[string]uint64{},
	}
	if holder != "" {
		e.holders[holder] = ep
	}
	w.watch[repo] = e
	w.evictLocked(now)
	f := w.onBaseline
	w.mu.Unlock()
	if f != nil {
		f(repo)
	}
}

// ReleaseScope 는 그 신원의 그 갈래 임대를 모든 저장소에서 놓는다 (FR-OPT-4-3). 감시는
// 여기서 걷지 않는다 — 임차인이 빈 항목은 마지막 표명에서 `ttl` 뒤에 만료된다
// (Detach 와 같은 규약).
func (w *GitWatcher) ReleaseScope(clientID, scope string) {
	if w == nil || clientID == "" {
		return
	}
	key := holderKey(clientID, scope)
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, e := range w.watch {
		delete(e.holders, key)
	}
}

/*
Attach 는 SSE 구독 하나를 신원에 결선한다 (FR-GWL-3).

`FocusRegistry.AttachFrom` 과 같은 규약이고 같은 자리에서 불린다
(`httpapi/commands.go`). epoch 를 주는 이유도 같다 — 재연결 뒤 도착한 옛 연결의
정리가 새 임대를 지우면 안 된다 (FR-XDF-10 의 선례).

두 registry 를 합치지 않는 이유는 다루는 것이 다르기 때문이다. Focus 는 "이 창을
누가 보는가"(창당 하나)이고 여기는 "이 저장소를 누가 보는가"(저장소당 여럿)다.
*/
func (w *GitWatcher) Attach(clientID string) uint64 {
	if w == nil || clientID == "" {
		return 0
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	w.epoch++
	w.live[clientID] = w.epoch
	return w.epoch
}

/*
Detach 는 그 신원을 모든 저장소의 임차인 목록에서 뺀다 (FR-GWL-3·4).

**grace period 는 없다** — 구독이 끝나는 것이 곧 해제다 (FR-XDF-9 와 같은 규약).
다만 감시를 여기서 걷지는 않는다: 임차인이 빈 항목은 종전 규칙으로 돌아가
마지막 표명에서 `ttl` 뒤에 만료된다 (FR-GWL-4). 브라우저를 닫으면 감시가 곧
걷힌다는 뜻이고, 그 사이 다른 창이 같은 저장소를 다시 표명하면 이어진다.

`ep` 가 그 신원의 최신 구독이 아니면 아무 일도 하지 않는다.
*/
func (w *GitWatcher) Detach(clientID string, ep uint64) {
	if w == nil || clientID == "" || ep == 0 {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.live[clientID] != ep {
		return // 더 새로운 구독이 이 신원을 들고 있다
	}
	delete(w.live, clientID)
	scoped := clientID + holderScopeSep
	for _, e := range w.watch {
		for k := range e.holders {
			if k == clientID || strings.HasPrefix(k, scoped) {
				delete(e.holders, k)
			}
		}
	}
}

// evictLocked 는 만료된 표명을 걷고, 그래도 상한을 넘으면 가장 오래된 것부터
// 뺀다 (FR-GPO-11·12).
func (w *GitWatcher) evictLocked(now time.Time) {
	for repo, e := range w.watch {
		// GIT_WATCH_LEASE_SRS FR-GWL-2: **임차인이 있으면 유휴로 걷지 않는다.**
		// 사용자는 Repo 창을 띄워 두고 터미널에서 작업하다 이따금 볼 수 있다 —
		// 그동안 표명이 뜸하다는 것은 안 본다는 뜻이 아니다. 만료의 사유는
		// 연결이 끊긴 것 하나이며, 그때는 Detach 가 이 목록을 비운다.
		if len(e.holders) > 0 {
			continue
		}
		if now.Sub(e.seenAt) > w.ttl {
			// GIT_LIVE_TRIGGERS_SRS FR-GLW-7: 만료는 **브라우저가 말을 멈춘 것**
			// 이다. 아래 Tick 의 탈락(저장소가 읽히지 않은 것)과 다른 사건이며,
			// 로그가 그 둘을 가르지 못하면 "방송이 오지 않았다" 의 원인을 사후에
			// 특정할 수 없다.
			dmlog.Infof(nil, "[gitwatch] 관심 표명 만료 — 감시를 걷는다 (repo=%s idle=%s)",
				repo, now.Sub(e.seenAt).Truncate(time.Second))
			delete(w.watch, repo)
		}
	}
	// 상한 퇴출 (FR-GPO-12 · FR-GWL-6).
	//
	// **임차인 없는 것이 먼저 나간다.** 그 둘을 섞어 표명 시각만 보면, 띄워 둔
	// 채 보고만 있는 창(표명이 뜸하다)이 방금 한 번 물어본 저장소에 밀려난다 —
	// FR-GWL-2 가 유휴 만료를 없앤 것과 같은 이유로 그 순서가 틀렸다.
	//
	// 퇴출을 로그로 남긴다. 종전에는 조용해서 "방송이 오지 않는다" 의 원인을
	// 사후에 특정할 수 없었다 (11-git-polling GP-16, FR-GLW-7 의 연장).
	for len(w.watch) > w.cap {
		oldest := oldestWatchLocked(w.watch, false)
		leased := false
		if oldest == "" {
			oldest, leased = oldestWatchLocked(w.watch, true), true
		}
		if oldest == "" {
			return
		}
		dmlog.Infof(nil, "[gitwatch] 상한 초과로 감시를 퇴출한다 (repo=%s cap=%d 임차인=%d)",
			oldest, w.cap, len(w.watch[oldest].holders))
		if leased {
			dmlog.Infof(nil, "[gitwatch] 퇴출된 저장소에 임차인이 남아 있었다 — 상한이 부족하다 (repo=%s)", oldest)
		}
		delete(w.watch, oldest)
	}
}

// oldestWatchLocked 는 표명이 가장 오래된 항목이다. `leased` 는 임차인이 있는
// 것을 볼지 없는 것을 볼지 가른다. 없으면 빈 문자열이다.
func oldestWatchLocked(watch map[string]*gitWatchEntry, leased bool) string {
	var oldest string
	var oldestAt time.Time
	for repo, e := range watch {
		if (len(e.holders) > 0) != leased {
			continue
		}
		if oldest == "" || e.seenAt.Before(oldestAt) {
			oldest, oldestAt = repo, e.seenAt
		}
	}
	return oldest
}

// Leases 는 지금 임대를 쥔 신원 수다 — 곧 clientId 를 실은 채 붙어 있는 SSE
// 구독의 수다 (FR-GWL-3). `FocusRegistry.LiveCount` 와 같은 자리이고 쓰임도 같다:
// 검사와 진단.
func (w *GitWatcher) Leases() int {
	if w == nil {
		return 0
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.live)
}

// Watching 은 지금 감시 중인 저장소 수다. 검사와 진단이 쓴다.
func (w *GitWatcher) Watching() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.watch)
}
