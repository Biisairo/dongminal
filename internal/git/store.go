package git

import (
	"container/list"
	"context"
	"sync"
	"time"
)

// 상한과 주기는 상수로 못박는다 — 호출 지점마다 다른 숫자가 흩어지면 상한이
// 상한이 아니게 된다.
const (
	DefaultStatusTTL   = 200 * time.Millisecond // O3. status 폴링 주기(1s)보다 짧다
	DefaultRepoRootTTL = 2 * time.Second
	DefaultGitDirsTTL  = 30 * time.Second
	DefaultObservedCap = 64 // 관측값을 들고 있을 리포 수 상한
)

// Observation 은 관측 한 번 + 언제 관측했는지다.
type Observation struct {
	Status           Status    `json:"status"`
	Signature        Signature `json:"signature"`
	ObservedAtUnixMs int64     `json:"observedAtUnixMs"`
}

// Store 는 git 조회 앞에 서서 세 가지를 한다.
//
//	① single-flight — 같은 리포의 같은 조회가 겹치면 한 번만 실행한다 (FR-GIT-21)
//	② TTL 캐시 — 브라우저 창이 여러 개여도 실행 횟수가 창 수에 비례하지 않는다 (FR-GIT-63)
//	③ 마지막 관측값 보관 — 활성이 아닌 리포의 배지가 딛는 값이다 (FR-GIT-24, O4)
//
// 폴링·디바운스는 여기 없다. 무엇을 언제 물을지는 클라이언트가 정하고, Store 는
// 물음이 겹칠 때 git 을 아끼는 일만 한다.
type Store struct {
	svc         *Service
	now         func() time.Time
	statusTTL   time.Duration
	repoRootTTL time.Duration
	gitDirsTTL  time.Duration
	observedCap int

	mu     sync.Mutex
	states map[string]*repoState
	lru    *list.List // front 가 최근 사용. Value 는 *repoState
	roots  map[string]rootEntry
	dirs   map[string]dirsEntry
}

// repoState 는 리포 하나의 진행 중 조회 + 마지막 관측값이다. 캐시와 관측값을
// 한 자리에 두는 이유는 Observed 가 "만료된 캐시"와 같은 것이기 때문이다.
type repoState struct {
	repo     string
	elem     *list.Element
	inflight *flight
	obs      Observation
	at       time.Time
	valid    bool
}

// flight 는 진행 중인 관측이다. 뒤따라온 호출자는 실행하지 않고 결과를 나눠 받는다.
type flight struct {
	done chan struct{}
	obs  Observation
	err  error
}

type rootEntry struct {
	root string
	err  error
	at   time.Time
}

type dirsEntry struct {
	gitDir    string
	commonDir string
	at        time.Time
}

type StoreOption func(*Store)

// WithStatusTTL 로 0 을 주면 캐시가 없다 — 주기 0 이 계층을 끄는 것과 같은 정신이다
// (FR-GIT-23). single-flight 는 그래도 동작한다.
func WithStatusTTL(d time.Duration) StoreOption {
	return func(st *Store) {
		if d < 0 {
			d = 0
		}
		st.statusTTL = d
	}
}

// WithClock 은 테스트가 시간을 지배하게 한다. TTL 검증이 실제 경과 시간에 의존하면
// 결정론을 잃는다.
func WithClock(now func() time.Time) StoreOption {
	return func(st *Store) {
		if now != nil {
			st.now = now
		}
	}
}

func NewStore(svc *Service, opts ...StoreOption) *Store {
	st := &Store{
		svc:         svc,
		now:         time.Now,
		statusTTL:   DefaultStatusTTL,
		repoRootTTL: DefaultRepoRootTTL,
		gitDirsTTL:  DefaultGitDirsTTL,
		observedCap: DefaultObservedCap,
		states:      map[string]*repoState{},
		lru:         list.New(),
		roots:       map[string]rootEntry{},
		dirs:        map[string]dirsEntry{},
	}
	for _, o := range opts {
		o(st)
	}
	return st
}

func (st *Store) Service() *Service { return st.svc }

// Status 는 캐시가 유효하면 그것을, 아니면 새로 관측해 돌려준다.
// cached 는 git 을 실행하지 않았음을 뜻한다 — 진행 중 조회에 붙은 호출자도 참이다.
func (st *Store) Status(ctx context.Context, repo string) (Observation, bool, error) {
	st.mu.Lock()
	s := st.stateLocked(repo)
	if s.valid && st.statusTTL > 0 && st.now().Sub(s.at) < st.statusTTL {
		obs := s.obs
		st.mu.Unlock()
		return obs, true, nil
	}
	if f := s.inflight; f != nil {
		st.mu.Unlock()
		<-f.done
		return f.obs, true, f.err
	}
	f := &flight{done: make(chan struct{})}
	s.inflight = f
	st.mu.Unlock()

	obs, err := st.observe(ctx, repo)

	st.mu.Lock()
	s.inflight = nil
	if err == nil {
		// 실패는 마지막 관측값을 덮지 않는다 — 한 번의 실패로 배지가 사라지면
		// 사용자는 변경이 없어진 것으로 읽는다.
		s.obs, s.at, s.valid = obs, st.now(), true
		st.lru.MoveToFront(s.elem)
	}
	st.evictLocked()
	st.mu.Unlock()

	f.obs, f.err = obs, err
	close(f.done)
	return obs, false, err
}

// Invalidate 는 그 리포의 status 캐시를 만료시킨다. 쓰기 직후의 재조회가 방금 만든
// 변경을 보지 못하면 화면이 거짓말을 한다 (FR-GIT-71).
//
// **마지막 관측값은 지우지 않는다** — 배지가 잠깐 사라지는 것보다 낡은 값이 낫고,
// 곧 새 관측이 덮는다. 만료시키는 것은 "캐시로 답해도 되는 시한"뿐이다.
func (st *Store) Invalidate(repo string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if s, ok := st.states[repo]; ok {
		s.at = time.Time{}
	}
}

// Observed 는 캐시를 **만료 여부와 무관하게** 준다. 활성이 아닌 리포의 배지가
// 이것을 쓴다 — 그래서 폴링 대상이 활성 1개로 유지된다 (FR-GIT-24).
func (st *Store) Observed(repo string) (Observation, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	s, ok := st.states[repo]
	if !ok || !s.valid {
		return Observation{}, false
	}
	st.lru.MoveToFront(s.elem)
	return s.obs, true
}

// Signature 는 gitdir 해석을 캐시해 감지 경로에서 git 이 돌지 않게 한다.
func (st *Store) Signature(ctx context.Context, repo string) (Signature, error) {
	gitDir, commonDir, err := st.gitDirs(ctx, repo)
	if err != nil {
		return Signature{}, err
	}
	return readSignature(gitDir, commonDir)
}

// RepoRoot 는 TTL 캐시를 거친다. 핀 목록이 길어도 rev-parse 가 항목 수만큼
// 반복되지 않아야 한다.
func (st *Store) RepoRoot(ctx context.Context, cwd string) (string, error) {
	st.mu.Lock()
	e, ok := st.roots[cwd]
	fresh := ok && st.now().Sub(e.at) < st.repoRootTTL
	st.mu.Unlock()
	if fresh {
		return e.root, e.err
	}
	root, err := st.svc.RepoRoot(ctx, cwd)
	st.mu.Lock()
	// 실패도 캐시한다. 저장소가 아니게 된 핀은 목록을 훑을 때마다 다시 물어지고,
	// TTL 이 2초여서 저장소가 생기면 곧 반영된다.
	pruneCache(st.roots, st.observedCap)
	st.roots[cwd] = rootEntry{root: root, err: err, at: st.now()}
	st.mu.Unlock()
	return root, err
}

// gitDirs 는 gitdir·common-dir 해석을 캐시한다. 실패는 캐시하지 않는다 — TTL 이
// 30초여서, 방금 만들어진 저장소가 그동안 계속 실패로 보이면 안 된다.
func (st *Store) gitDirs(ctx context.Context, repo string) (string, string, error) {
	st.mu.Lock()
	e, ok := st.dirs[repo]
	fresh := ok && st.now().Sub(e.at) < st.gitDirsTTL
	st.mu.Unlock()
	if fresh {
		return e.gitDir, e.commonDir, nil
	}
	gitDir, commonDir, err := st.svc.GitDirs(ctx, repo)
	if err != nil {
		return "", "", err
	}
	st.mu.Lock()
	pruneCache(st.dirs, st.observedCap)
	st.dirs[repo] = dirsEntry{gitDir: gitDir, commonDir: commonDir, at: st.now()}
	st.mu.Unlock()
	return gitDir, commonDir, nil
}

// observe 는 status 와 signature 를 한 번에 채운다. signature 는 stat 2회라
// 사실상 무료이고, 클라이언트가 status 직후 signature 를 또 부르지 않게 한다.
func (st *Store) observe(ctx context.Context, repo string) (Observation, error) {
	status, err := st.svc.Status(ctx, repo)
	if err != nil {
		return Observation{}, err
	}
	sig, err := st.Signature(ctx, repo)
	if err != nil {
		return Observation{}, err
	}
	return Observation{Status: status, Signature: sig, ObservedAtUnixMs: st.now().UnixMilli()}, nil
}

func (st *Store) stateLocked(repo string) *repoState {
	if s, ok := st.states[repo]; ok {
		st.lru.MoveToFront(s.elem)
		return s
	}
	s := &repoState{repo: repo}
	s.elem = st.lru.PushFront(s)
	st.states[repo] = s
	return s
}

// evictLocked 는 보관량을 상한 아래로 되돌린다. 진행 중인 항목은 남긴다 — 그것을
// 지우면 뒤이은 요청이 같은 조회를 다시 실행한다.
func (st *Store) evictLocked() {
	for st.lru.Len() > st.observedCap {
		e := st.lru.Back()
		for e != nil && e.Value.(*repoState).inflight != nil {
			e = e.Prev()
		}
		if e == nil {
			return
		}
		st.lru.Remove(e)
		delete(st.states, e.Value.(*repoState).repo)
	}
}

// pruneCache 는 TTL 캐시가 무한히 자라지 않게 한다. 항목이 싸고 TTL 이 짧으므로
// 개별 LRU 를 둘 값이 없다 — 상한에 닿으면 통째로 버리고 다시 채운다.
func pruneCache[V any](m map[string]V, cap int) {
	if len(m) >= cap {
		clear(m)
	}
}
