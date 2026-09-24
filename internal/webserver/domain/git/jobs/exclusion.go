package jobs

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"dongminal/internal/webserver/domain/git/core"
)

// ErrRepoBusy 는 dongminal 의 다른 동기 쓰기가 잠금을 쥐고 있어 대기 상한을
// 넘겼다는 것이다 (REPO_FIX 01 §7.1). 잡이 칸을 쥔 경우(ErrJobBusy)와 가른다 —
// 이쪽은 곧 풀리고, 저쪽은 분 단위일 수 있다.
var ErrRepoBusy = errors.New("repo_busy")

// 잡 칸의 이름이다 (§5.4). Job JSON `slots` 와 프런트 잠금이 같은 문자열을 본다.
const (
	// SlotIndex 는 index·작업 트리·HEAD 를 바꾸는 잡의 칸이다. toplevel 키로 찾는다.
	SlotIndex = "index"
	// SlotCommon 은 원격 ref·worktrees/ 처럼 worktree 들이 공유하는 것을 바꾸는
	// 잡의 칸이다. common-dir 키로 찾는다.
	SlotCommon = "common"
)

// commonKinds 는 index 를 건드리지 않는 잡이다. pull 은 index 를 바꾸고 원격 ref
// 도 받으므로 두 칸 모두다.
var commonKinds = map[string]bool{"fetch": true, "push": true, "submodule": true, "worktree": true}

// SlotsOf 는 kind 가 차지하는 칸이다. 서버가 kind 에서 파생한다 — 요청이 칸을
// 고르게 하면 칸이 배타가 아니게 된다.
func SlotsOf(kind string) []string {
	switch {
	case kind == "pull":
		return []string{SlotIndex, SlotCommon}
	case commonKinds[kind]:
		return []string{SlotCommon}
	default:
		return []string{SlotIndex}
	}
}

// Keys 는 쓰기·잡 하나의 배타 키다 (§5.1). 둘 다 core.ExclusionKey 로 정규화한
// 값이며 Job.Repo 와 따로 받는다 — Repo 는 응답·캐시 키로 RepoRoot 출력 그대로다.
type Keys struct {
	Top    string // `--show-toplevel`
	Common string // `--git-common-dir` 절대화
}

// Exclusion 은 저장소 배타 상태 전부다 (§5.4) — toplevel 뮤텍스, common-dir 잠금,
// 잡의 두 칸. **서버에 하나만 있어야 한다**: 동기 쓰기·잡·Run 격리가 서로 다른
// 인스턴스를 보면 배타가 없는 것과 같다. 합성 루트(buildDeps)가 만들어 주입한다.
//
// 잠금 순서는 전역으로 common-dir → toplevel → worktree repoLock 이다. 모든 경로가
// 그 부분열이므로 교착이 없다.
type Exclusion struct {
	mu      sync.Mutex
	tops    map[string]*sem
	commons map[string]*sem
	index   map[string]string // toplevel 키 → 잡 id
	common  map[string]string // common-dir 키 → 잡 id
}

// sem 은 ctx·시한을 존중하는 잠금 하나다. sync.Mutex 는 기다리는 쪽을 깨울 수
// 없어서 요청이 떠나도 대기가 남는다.
type sem struct {
	ch   chan struct{}
	refs int // 쥔 쪽 + 기다리는 쪽. 0 이 되면 자리를 지운다
}

func NewExclusion() *Exclusion {
	return &Exclusion{
		tops:    map[string]*sem{},
		commons: map[string]*sem{},
		index:   map[string]string{},
		common:  map[string]string{},
	}
}

// LockTop 은 toplevel 뮤텍스를 wait 까지 기다린다. 상한 초과는 ErrRepoBusy, 요청
// 취소는 ErrCanceled 이고 어느 쪽도 잠금을 쥐지 않는다. 돌려준 release 는 여러 번
// 불러도 한 번만 반납한다.
func (x *Exclusion) LockTop(ctx context.Context, key string, wait time.Duration) (func(), error) {
	return x.acquire(ctx, x.tops, key, wait)
}

// LockCommon 은 common-dir 잠금이다 — stash 5종이 toplevel 뮤텍스 앞에 쥔다.
// `refs/stash` 는 worktree 들이 공유하므로 toplevel 뮤텍스로는 막을 수 없다.
func (x *Exclusion) LockCommon(ctx context.Context, key string, wait time.Duration) (func(), error) {
	return x.acquire(ctx, x.commons, key, wait)
}

// TryLockTop 은 기다리지 않는다. 사용 중인 worktree 를 지우지 않으려는 Run 격리
// 정리가 쓴다 — 기다렸다 지우면 막 끝난 쓰기의 작업 트리를 지운다.
func (x *Exclusion) TryLockTop(key string) (func(), bool) {
	x.mu.Lock()
	s := x.refLocked(x.tops, key)
	x.mu.Unlock()
	select {
	case s.ch <- struct{}{}:
		return x.releaser(x.tops, key, s), true
	default:
		x.unref(x.tops, key, s)
		return nil, false
	}
}

// IndexBusy 는 toplevel 키의 index 칸을 쥔 잡이다.
func (x *Exclusion) IndexBusy(top string) (string, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	id, ok := x.index[top]
	return id, ok
}

// CommonBusy 는 common-dir 키의 common 칸을 쥔 잡이다.
func (x *Exclusion) CommonBusy(common string) (string, bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	id, ok := x.common[common]
	return id, ok
}

func (x *Exclusion) acquire(ctx context.Context, m map[string]*sem, key string, wait time.Duration) (func(), error) {
	// 잠금이 비어 있어도 떠난 요청은 쥐지 않는다 — select 는 준비된 갈래를 무작위로
	// 고르므로 먼저 본다.
	if err := ctxErr(ctx); err != nil {
		return nil, err
	}
	x.mu.Lock()
	s := x.refLocked(m, key)
	x.mu.Unlock()
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case s.ch <- struct{}{}:
		return x.releaser(m, key, s), nil
	case <-ctx.Done():
		x.unref(m, key, s)
		return nil, ctxErr(ctx)
	case <-timer.C:
		x.unref(m, key, s)
		return nil, fmt.Errorf("%w: %s 의 쓰기가 %v 안에 끝나지 않았다", ErrRepoBusy, key, wait)
	}
}

func (x *Exclusion) refLocked(m map[string]*sem, key string) *sem {
	s, ok := m[key]
	if !ok {
		s = &sem{ch: make(chan struct{}, 1)}
		m[key] = s
	}
	s.refs++
	return s
}

func (x *Exclusion) unref(m map[string]*sem, key string, s *sem) {
	x.mu.Lock()
	defer x.mu.Unlock()
	s.refs--
	if s.refs == 0 && m[key] == s {
		delete(m, key)
	}
}

func (x *Exclusion) releaser(m map[string]*sem, key string, s *sem) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			<-s.ch
			x.unref(m, key, s)
		})
	}
}

// claim 은 잡 id 로 칸을 차지한다. 하나라도 차 있으면 아무것도 차지하지 않고
// ErrJobBusy 다 — pull 이 한 칸만 쥔 채 남는 경로가 없다.
func (x *Exclusion) claim(k Keys, slots []string, id string) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	for _, slot := range slots {
		m, key := x.slotLocked(k, slot)
		if other, busy := m[key]; busy {
			return fmt.Errorf("%w: %s 의 %s 칸에 진행 중인 작업이 있다 (%s)", ErrJobBusy, key, slot, other)
		}
	}
	for _, slot := range slots {
		m, key := x.slotLocked(k, slot)
		m[key] = id
	}
	return nil
}

// free 는 id 가 쥔 칸만 비운다 — 이미 다른 잡이 차지한 칸을 지우지 않는다.
func (x *Exclusion) free(k Keys, slots []string, id string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	for _, slot := range slots {
		m, key := x.slotLocked(k, slot)
		if m[key] == id {
			delete(m, key)
		}
	}
}

func (x *Exclusion) slotLocked(k Keys, slot string) (map[string]string, string) {
	if slot == SlotIndex {
		return x.index, k.Top
	}
	return x.common, k.Common
}

// ctxErr 는 ctx 의 끝을 core 의 분류로 옮긴다. 요청이 떠난 것은 서버 실패가 아니다.
func ctxErr(ctx context.Context) error {
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return fmt.Errorf("%w: 잠금을 기다리다 마감을 넘겼다", core.ErrTimeout)
	case ctx.Err() != nil:
		return fmt.Errorf("%w: 잠금을 기다리는 동안 요청이 떠났다", core.ErrCanceled)
	}
	return nil
}
