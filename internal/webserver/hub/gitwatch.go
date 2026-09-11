package hub

import (
	"context"
	"dongminal/internal/shared/dmlog"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"strconv"
	"sync"
	"time"

	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/store"
)

// git 관측을 서버가 밀어 준다 (GIT_PUSH_OBSERVE_SRS 묶음 W·S).
//
// 종전에는 브라우저가 저장소 하나를 보는 동안 **60초에 180번** 물었다 —
// signature 120회(500ms)와 status 60회(1s). 변화가 한 번도 없어도 그랬다.
// 그 물음의 답은 누가 묻든 같고, 서버는 이미 알고 있다.
//
// 형태는 `foreground.go` 를 그대로 따른다: 티커 하나, **값이 바뀐 것에 대해서만**
// 방송. 그 파일의 주석이 이 설계의 논거를 미리 적어 두었다 — "C-3 이 막는 것은
// 브라우저의 새 요청이며, 그것은 늘지 않는다." 서버가 도는 것은 요청이 아니다.
//
// **signature 만으로는 부족하다.** 그 값은 `HEAD`·`index`·`refs` 를 보므로
// 작업 트리의 파일 생성·수정·삭제를 잡지 못한다. 종전에 그것을 잡던 것은
// signature 폴링(500ms)이 아니라 **status 폴링(1s)** 이었다 — 그러므로 여기서
// 관측하는 것도 status 여야 한다. 이 사실은 검사가 잡았다: 작업 트리에 파일을
// 만드는 e2e 가 방송을 받지 못했다 (GIT_PUSH_OBSERVE_SRS §2.7).
//
// 비용은 옮겨질 뿐 늘지 않는다. 종전에도 브라우저가 1초마다 status 를 시켰고
// 그것이 서버에서 git 을 돌렸다. 이제 서버가 스스로 돌리고 **결과가 바뀌었을
// 때만** 알린다 — git 실행 횟수는 같고 네트워크 왕복이 사라진다.
//
// 파일 감시(`fsnotify`)를 쓰지 않는 이유는 그대로다: signature 는 실측으로
// 다듬어진 것이고(`RefsShape` 는 "Windows 러너에서 `git branch` 뒤 디렉터리
// mtime 이 45초 동안 그대로였다", FR-CEM-32) 작업 트리 쪽은 `git status` 가
// 이미 정확하다. 감시로 바꾸면 두 지식을 다 버리고 플랫폼별 한계를 떠안는다.

const (
	// GitWatchInterval 은 감시 회차의 주기다 (FR-GPO-2). 브라우저의 종전
	// **status** 주기와 같다 — 사용자가 보는 갱신 속도가 느려지면 안 된다.
	// signature 주기(500ms)가 아닌 이유는 이 회차가 status 를 관측하기 때문이다.
	GitWatchInterval = 1000 * time.Millisecond

	// GitWatchTTL 은 관심 표명의 수명이다 (FR-GPO-11). 브라우저의 안전망
	// 폴링(30초)보다 세 배 길다 — 보고 있는 동안에는 만료되지 않는다.
	GitWatchTTL = 90 * time.Second

	// GitWatchCap 은 동시에 감시하는 저장소 수의 상한이다 (FR-GPO-12).
	// 브라우저 여럿이 각자 다른 저장소를 봐도 이 안에 든다.
	GitWatchCap = 16
)

// GitObserver 는 감시자가 필요로 하는 것 전부다. `store.Store` 가 이것을
// 만족한다 — 인터페이스로 받는 이유는 검사가 git 저장소 없이 이 계층만 시험할
// 수 있게 하기 위해서다.
//
// `Status` 는 Store 의 TTL 캐시와 single-flight 를 지난다 (FR-GIT-21·63). 감시
// 회차가 브라우저의 요청과 겹치면 git 은 한 번만 돈다.
type GitObserver interface {
	Status(ctx context.Context, repo string) (store.Observation, bool, error)
}

// obsMark 는 관측 하나를 비교 가능한 한 줄로 접는다.
//
// **무엇이 바뀌면 알려야 하는가** 의 정의다. signature 는 `.git` 의 변화를,
// 파일 수와 그 목록의 해시는 작업 트리의 변화를 잡는다. 브랜치·ahead/behind 는
// 화면 머리글이 그것으로 서므로 함께 본다.
//
// 파일 목록 전체를 문자열로 잇지 않는 이유는 수천 개일 수 있기 때문이다 —
// 이름과 상태만 순서대로 접는다. 순서는 `git status` 가 정하므로 결정적이다.
func obsMark(o store.Observation) string {
	h := fnv.New64a()
	fmt.Fprintf(h, "%s|%s|%s|%t|%d|%d|",
		o.Signature.Value, o.Status.Oid, o.Status.Branch, o.Status.Detached,
		o.Status.Ahead, o.Status.Behind)
	// Conflicts 가 빠져 있었다. 머지가 멈춘 동안 사용자가 손대는 것이 바로 그
	// 파일들인데, 그 변화만 방송이 잡지 못해 30초 안전망까지 화면이 낡았다.
	for _, g := range [][]query.FileEntry{
		o.Status.Staged, o.Status.Changes, o.Status.Untracked, o.Status.Conflicts,
	} {
		fmt.Fprintf(h, "#%d", len(g))
		for _, f := range g {
			fmt.Fprintf(h, "%s:%s:%s;", f.Path, f.XY, f.Sub)
		}
	}
	return strconv.FormatUint(h.Sum64(), 36)
}

// gitChangedPayload 는 `git_changed` SSE 본문이다. 서버만 내보낸다.
//
// **status 를 싣지 않는다.** 방송은 "바뀌었다" 만 나르고 내용은 브라우저가 받아
// 간다 — status 응답은 파일 목록 전체라 크고, 보는 이가 없을 수도 있다.
// FR-BGV-1 이 백그라운드 목록에 쓴 것과 같은 판단이다.
//
// `mark` 는 **관측 하나의 식별자**다 (FR-GPO-4). 브라우저가 "이미 받은 알림인지"
// 를 판정해 재연결 직후의 중복 수집을 막는다 (FR-GPO-22).
//
// **signature 를 싣지 않는다.** 처음에는 그것을 실었는데, signature 는 `.git` 만
// 보므로 작업 트리 변화에서는 값이 그대로다 — 브라우저의 중복 거르기가 그 알림을
// 통째로 삼켰다 (§2.9). 식별자는 방송을 내보내게 만든 그 판단과 **같은 것**이어야
// 한다.
func gitChangedPayload(repo, mark string) []byte {
	b, _ := json.Marshal(map[string]any{
		"action": "git_changed",
		"args":   map[string]any{"repo": repo, "mark": mark},
	})
	return b
}

// GitWatcher 는 관심 표명을 받아 두었다가 회차마다 그 저장소들의 signature 를
// 확인한다.
type GitWatcher struct {
	git GitObserver
	hub CommandBroker
	now func() time.Time
	ttl time.Duration
	cap int

	mu    sync.Mutex
	watch map[string]*gitWatchEntry
	// live 는 신원마다 **가장 새로운** SSE 구독의 epoch 다
	// (GIT_WATCH_LEASE_SRS FR-GWL-3). 여기 없는 신원은 임차인이 될 수 없다.
	live  map[string]uint64
	epoch uint64
}

type gitWatchEntry struct {
	lastMark string
	seenAt   time.Time // 마지막 관심 표명 시각
	hasMark  bool
	// holders 는 이 저장소를 보고 있는 신원들이다 (clientId → 그 구독의 epoch).
	// **비어 있지 않으면 유휴로 만료되지 않는다** (FR-GWL-2).
	holders map[string]uint64
}

func NewGitWatcher(git GitObserver, hub CommandBroker) *GitWatcher {
	return &GitWatcher{
		git: git, hub: hub, now: time.Now,
		ttl: GitWatchTTL, cap: GitWatchCap,
		watch: map[string]*gitWatchEntry{},
		live:  map[string]uint64{},
	}
}

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
	if w == nil || repo == "" {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	now := w.now()
	mark := obsMark(obs)
	// 구독이 살아 있는 신원만 임차인이 된다.
	ep := w.live[clientID]
	if clientID == "" || ep == 0 {
		clientID = ""
	}
	if e, ok := w.watch[repo]; ok {
		e.seenAt = now
		if clientID != "" {
			e.holders[clientID] = ep
		}
		// **기준선을 여기서 갱신하지 않는다.** 브라우저가 받은 관측과 감시자가
		// 마지막으로 알린 관측은 같은 것이고, 다르다면 그 차이는 이미 방송으로
		// 나갔다. 여기서 덮으면 그 방송과 이 응답 사이에 생긴 변화를 잃는다.
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
	e := &gitWatchEntry{seenAt: now, lastMark: mark, hasMark: true, holders: map[string]uint64{}}
	if clientID != "" {
		e.holders[clientID] = ep
	}
	w.watch[repo] = e
	w.evictLocked(now)
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
	for _, e := range w.watch {
		delete(e.holders, clientID)
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

/*
Tick 은 회차 하나다 (FR-GPO-3).

감시 대상 각각의 signature 를 읽고 **직전 값과 다를 때만** 방송한다. 같으면
아무것도 하지 않는다 — `SetForegroundNotifier` 가 "값이 바뀌었을 때만 부른다"
(FR-TAN-9)로 세운 계약과 같다.

첫 회차는 방송하지 않는다. 그때의 signature 는 "바뀐 것" 이 아니라 기준선이며,
브라우저는 방금 status 를 받아 그 값을 이미 알고 있다.

읽기 오류는 그 저장소를 대상에서 뺀다 (FR-GPO-5). 저장소가 사라졌거나 gitdir 이
깨진 것이고, 그 판정과 화면 처리는 브라우저의 `GIT_REPO_MISSING` 경로가 이미
갖고 있다 (FR-RMS-6) — 감시자가 그것을 흉내내지 않는다.
*/
func (w *GitWatcher) Tick(ctx context.Context) int {
	if w == nil || w.git == nil {
		return 0
	}
	w.mu.Lock()
	now := w.now()
	w.evictLocked(now)
	repos := make([]string, 0, len(w.watch))
	for repo := range w.watch {
		repos = append(repos, repo)
	}
	w.mu.Unlock()

	sent := 0
	for _, repo := range repos {
		obs, _, err := w.git.Status(ctx, repo)
		mark := ""
		if err == nil {
			mark = obsMark(obs)
		}
		w.mu.Lock()
		e, ok := w.watch[repo]
		if !ok { // 회차 중에 만료·퇴출됐다
			w.mu.Unlock()
			continue
		}
		if err != nil {
			// FR-GLW-7: 탈락은 **저장소가 읽히지 않은 것**이다 (FR-GPO-5).
			// 되풀이되지 않는다 — 이 저장소는 여기서 대상에서 빠진다.
			dmlog.Errorf(nil, "[gitwatch] 관측 실패로 감시에서 뺀다 (repo=%s err=%v)", repo, err)
			delete(w.watch, repo)
			w.mu.Unlock()
			continue
		}
		first := !e.hasMark
		changed := e.hasMark && e.lastMark != mark
		e.lastMark, e.hasMark = mark, true
		w.mu.Unlock()

		if first || !changed {
			continue
		}
		if w.hub != nil {
			w.hub.Broadcast(gitChangedPayload(repo, mark))
		}
		sent++
	}
	return sent
}

/*
StartGitWatch 는 회차를 도는 주체다 (FR-GPO-13).

대상이 없어도 티커는 돈다. 멈췄다 켜는 대신 빈 순회를 하는 이유는, 시작·정지의
경합을 다루는 비용이 500ms 마다의 빈 순회보다 크기 때문이다 — 빈 순회는 맵
하나를 잠그고 길이를 보는 일이다.
*/
func StartGitWatch(w *GitWatcher, stopCh <-chan struct{}) {
	if w == nil {
		return
	}
	go func() {
		t := time.NewTicker(GitWatchInterval)
		defer t.Stop()
		ctx := context.Background()
		for {
			select {
			case <-t.C:
				w.Tick(ctx)
			case <-stopCh:
				return
			}
		}
	}()
}
