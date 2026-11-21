package hub

import (
	"context"
	"dongminal/internal/webserver/sse"
	"hash/fnv"
	"sync"
	"sync/atomic"
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
	GitWatchInterval = 1000 * time.Millisecond

	// GitWatchWorktreeEvery 는 **워크트리 회차**의 간격이다 (FR-GDT-3).
	//
	// signature 가 같아도 이 회차에서는 `git status` 를 돌린다 — 작업 트리의
	// 파일 생성·수정·삭제는 signature 가 보지 못하고, 그것을 잡는 길이 이것뿐이기
	// 때문이다 (`gitwatch.go` 머리말이 실측으로 확인한 사실).
	//
	// 4 는 약 4초다. 브라우저 안전망(30초)보다 훨씬 짧으므로 사용자가 겪는 갱신은
	// 여전히 서버 푸시다 (FR-GDT-6).
	GitWatchWorktreeEvery = 4

	// GitWatchRoundTimeout 은 회차 하나의 시한이다 (FR-GDT-9 · `GO-33`).
	//
	// **회차의 것이지 저장소의 것이 아니다** (D-GDT-7). 저장소마다 걸면 느린
	// 저장소 하나가 회차를 늘 이 값까지 붙든다. 회차에 걸면 그 안의 병렬 관측이
	// 함께 끊기고, 다음 회차가 1초 뒤에 오므로 잃는 것이 없다.
	GitWatchRoundTimeout = 20 * time.Second

	// GitWatchParallel 은 한 회차에서 동시에 도는 관측 수의 상한이다 (FR-GDT-8).
	// `gitObserveMax` 와 같은 값이며 같은 이유다 — 대상이 늘어도 git 프로세스가
	// 대상 수만큼 한꺼번에 뜨지 않게 한다.
	GitWatchParallel = 4

	// GitWatchTTL 은 관심 표명의 수명이다 (FR-GPO-11). 브라우저의 안전망
	// 폴링(30초)보다 세 배 길다 — 보고 있는 동안에는 만료되지 않는다.
	GitWatchTTL = 90 * time.Second

	// GitWatchCap 은 동시에 감시하는 저장소 수의 상한이다 (FR-GPO-12).
	// 브라우저 여럿이 각자 다른 저장소를 봐도 이 안에 든다.
	GitWatchCap = 16

	// GitWatchBackoffMax 는 일시적 관측 실패 뒤 그 저장소를 건너뛰는 시간의 상한이다
	// (REPO_FIX 02 §3A-1 — min(2^(n-1), 30)s).
	GitWatchBackoffMax = 30 * time.Second
)

// GitObserver 는 감시자가 필요로 하는 것 전부다. `store.Store` 가 이것을
// 만족한다 — 인터페이스로 받는 이유는 검사가 git 저장소 없이 이 계층만 시험할
// 수 있게 하기 위해서다.
//
// `Status` 는 Store 의 TTL 캐시와 single-flight 를 지난다 (FR-GIT-21·63). 감시
// 회차가 브라우저의 요청과 겹치면 git 은 한 번만 돈다.
type GitObserver interface {
	Status(ctx context.Context, repo string) (store.Observation, bool, error)
	// Signature 는 **1차 게이트**다 (GIT_DETECT_TIER_SRS FR-GDT-1).
	// git 을 실행하지 않는다 — read 1회 + stat 몇 번이다.
	Signature(ctx context.Context, repo string) (query.Signature, error)
	// Invalidate 는 세대를 올린다 (REPO_FIX 01 §4) — signature 가 바뀐 회차가 TTL
	// 캐시·옛 flight 의 변화 전 관측을 받지 않게 한다.
	Invalidate(repo string)
	// Observed 는 마지막 유효 관측이다. 회차 시한이 놓친 관측을 다음 회차가 받는다.
	Observed(repo string) (store.Observation, bool)
	// ForgetRoot 는 루트 해석의 기억(TTL 2초)을 지운다. 탈락을 알리기 전에 부른다 —
	// 알림을 받고 곧바로 묻는 목록(`/api/git/repos`)이 옛 해석을 받지 않게 한다 (FR-OPT-4-3).
	ForgetRoot(path string)
}

// obsMark 는 관측 식별자다. 정의는 store.Mark 한 벌이다 (REPO_FIX 04 §3A-0 X5) —
// status 응답의 `mark` 와 `git_changed` 의 `mark` 가 같은 관측에서 같은 값이어야
// 화면이 "이미 받은 관측인가" 를 한 기준으로 판정한다.
func obsMark(o store.Observation) string { return store.Mark(o) }

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
	return sse.Payload("git_changed", map[string]any{"repo": repo, "mark": mark})
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
	// round 는 회차 번호다. 워크트리 회차의 판정이 이것을 딛는다 (FR-GDT-3·4).
	round uint64
	// onChanged 는 git_changed 를 방송할 때 그 저장소로 불린다 (REPO_FIX 02 §3A-6) —
	// LSP 가 열린 문서를 디스크 판으로 맞춘다. 감시자는 그것이 무엇인지 모른다.
	onChanged func(repo string)
	// onBaseline 은 저장소의 첫 표명(기준선)에 그 저장소로 불린다 (CODEMIRROR_MIGRATION_SRS §11.6 W) —
	// LSP 가 그 관측을 직전 관측으로 기억한다.
	onBaseline func(repo string)

	// worktreeEvery 는 워크트리 회차의 간격(회차 수)이다. 0 이면 `GitWatchWorktreeEvery` 다
	// (EDITOR_LIVE_RELOAD_SRS FR-ELR-76).
	worktreeEvery atomic.Uint64
	// after 는 계기 관측의 시간을 주입하는 자리다 (FR-ELR-75). 기본은 `time.AfterFunc` 다.
	after func(d time.Duration, f func()) func() bool
	// root 는 `StartGitWatch` 의 뿌리 컨텍스트다. 계기 관측도 종료와 함께 취소된다.
	root  context.Context
	kicks map[string]*gitKick
}

// SetOnBaseline 은 기준선 훅을 건다 (CODEMIRROR_MIGRATION_SRS §11.6 W). 합성 루트가 한 번 부른다.
func (w *GitWatcher) SetOnBaseline(f func(repo string)) {
	if w == nil {
		return
	}
	w.mu.Lock()
	w.onBaseline = f
	w.mu.Unlock()
}

// SetOnChanged 는 방송 훅을 건다. 합성 루트가 한 번 부른다.
func (w *GitWatcher) SetOnChanged(f func(repo string)) {
	if w == nil {
		return
	}
	w.mu.Lock()
	w.onChanged = f
	w.mu.Unlock()
}

// announce 는 git_changed 를 방송하고 훅을 부른다.
func (w *GitWatcher) announce(repo, mark string) {
	if w.hub != nil {
		w.hub.Broadcast(gitChangedPayload(repo, mark))
	}
	w.mu.Lock()
	f := w.onChanged
	w.mu.Unlock()
	if f != nil {
		f(repo)
	}
}

type gitWatchEntry struct {
	lastMark string
	seenAt   time.Time // 마지막 관심 표명 시각
	hasMark  bool
	// lastSig 는 1차 게이트의 직전 값이다 (FR-GDT-1·2).
	lastSig string
	hasSig  bool
	// phase 는 워크트리 회차의 위상이다 (FR-GDT-4). 저장소 경로에서 파생하므로
	// 같은 저장소는 늘 같은 위상을 갖고, 다른 저장소는 흩어진다.
	phase uint64
	// holders 는 이 저장소를 보고 있는 신원들이다 (clientId[+갈래] → 그 구독의 epoch).
	// **비어 있지 않으면 유휴로 만료되지 않는다** (FR-GWL-2).
	holders map[string]uint64

	// REPO_FIX 02 §3A-1. pending 은 "signature 가 바뀌어 변화 이후의 관측을 기다린다"
	// 이다 — lastSig 는 그 관측이 성립한 뒤에만 pendingSig 로 확정한다.
	pending    bool
	pendingSig string
	pendingAt  time.Time
	// fails·retryAt 은 일시적 관측 실패의 연속 횟수와 다음 관측 시각이다.
	fails   int
	retryAt time.Time
}

// watchPhase 는 저장소 경로에서 워크트리 회차의 위상을 뽑는다 (FR-GDT-4).
func watchPhase(repo string) uint64 {
	return phaseHash(repo) % GitWatchWorktreeEvery
}

// phaseHash 는 위상의 원천이다. 간격이 설정으로 바뀌므로(FR-ELR-76) 나머지는 회차마다 구한다.
func phaseHash(repo string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(repo))
	return h.Sum64()
}

func NewGitWatcher(git GitObserver, hub CommandBroker) *GitWatcher {
	return &GitWatcher{
		git: git, hub: hub, now: time.Now,
		ttl: GitWatchTTL, cap: GitWatchCap,
		watch: map[string]*gitWatchEntry{},
		live:  map[string]uint64{},
	}
}
