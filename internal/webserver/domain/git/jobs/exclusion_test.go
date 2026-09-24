package jobs

import (
	"context"
	"errors"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/git/core"
)

// REPO_FIX 01 §5.4 — 배타 상태. 잠금 대기는 상한을 넘으면 ErrRepoBusy, 대기 중
// 요청이 떠나면 ErrCanceled 이고 어느 쪽도 잠금을 쥐지 않는다.

const testWait = 60 * time.Millisecond

// idle 은 쥐거나 기다리는 쪽이 하나도 없는가다 — 자리 누수 검증용.
func (x *Exclusion) idle() bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	return len(x.tops) == 0 && len(x.commons) == 0 && len(x.index) == 0 && len(x.common) == 0
}

func TestExclusionLockTop_WaitsThenRepoBusy(t *testing.T) {
	x := NewExclusion()
	release, err := x.LockTop(context.Background(), "/k", testWait)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := x.LockTop(context.Background(), "/k", testWait); !errors.Is(err, ErrRepoBusy) {
		t.Fatalf("두 번째 LockTop err = %v, want ErrRepoBusy", err)
	}
	if el := time.Since(started); el < testWait {
		t.Fatalf("상한 %v 을 기다리지 않았다 (%v)", testWait, el)
	}
	release()
	release() // 두 번 불러도 한 번만 반납한다
	r2, err := x.LockTop(context.Background(), "/k", testWait)
	if err != nil {
		t.Fatalf("반납 뒤 LockTop: %v", err)
	}
	r2()
}

func TestExclusionLockTop_AcquiresWhenReleasedDuringWait(t *testing.T) {
	x := NewExclusion()
	release, _ := x.LockTop(context.Background(), "/k", testWait)
	go func() {
		time.Sleep(testWait / 3)
		release()
	}()
	r2, err := x.LockTop(context.Background(), "/k", time.Second)
	if err != nil {
		t.Fatalf("대기 중 반납된 잠금을 얻지 못했다: %v", err)
	}
	r2()
}

func TestExclusionLockTop_CanceledWhileWaiting(t *testing.T) {
	x := NewExclusion()
	release, _ := x.LockTop(context.Background(), "/k", testWait)
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(testWait / 3)
		cancel()
	}()
	if _, err := x.LockTop(ctx, "/k", time.Second); !errors.Is(err, core.ErrCanceled) {
		t.Fatalf("대기 중 취소 err = %v, want ErrCanceled", err)
	}
	release()
	if !x.idle() {
		t.Fatal("취소된 대기자가 잠금 자리를 남겼다")
	}
}

// 잠금이 비어 있어도 요청이 이미 떠났으면 쥐지 않는다 — 떠난 요청이 실행되지 않게.
func TestExclusionLockTop_AlreadyCanceled(t *testing.T) {
	x := NewExclusion()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := x.LockTop(ctx, "/k", testWait); !errors.Is(err, core.ErrCanceled) {
		t.Fatalf("err = %v, want ErrCanceled", err)
	}
	if !x.idle() {
		t.Fatal("떠난 요청이 잠금을 쥐었다")
	}
}

func TestExclusion_KeysAndKindsIndependent(t *testing.T) {
	x := NewExclusion()
	a, err := x.LockTop(context.Background(), "/a", testWait)
	if err != nil {
		t.Fatal(err)
	}
	b, err := x.LockTop(context.Background(), "/b", testWait)
	if err != nil {
		t.Fatalf("다른 키가 막혔다: %v", err)
	}
	// 같은 문자열이어도 common-dir 잠금은 toplevel 뮤텍스와 다른 자리다.
	c, err := x.LockCommon(context.Background(), "/a", testWait)
	if err != nil {
		t.Fatalf("common-dir 잠금이 toplevel 뮤텍스에 막혔다: %v", err)
	}
	a()
	b()
	c()
	if !x.idle() {
		t.Fatal("모두 반납했는데 자리가 남았다")
	}
}

func TestExclusionTryLockTop(t *testing.T) {
	x := NewExclusion()
	release, ok := x.TryLockTop("/k")
	if !ok {
		t.Fatal("빈 잠금을 TryLock 하지 못했다")
	}
	if _, ok := x.TryLockTop("/k"); ok {
		t.Fatal("쥔 잠금을 TryLock 이 또 얻었다")
	}
	release()
	r2, ok := x.TryLockTop("/k")
	if !ok {
		t.Fatal("반납 뒤 TryLock 실패")
	}
	r2()
}

// 칸 확인 — index 칸은 toplevel 키, common 칸은 common-dir 키로 찾는다.
func TestExclusionSlots(t *testing.T) {
	x := NewExclusion()
	k := Keys{Top: "/wt", Common: "/main/.git"}
	if err := x.claim(k, SlotsOf("pull"), "j1"); err != nil {
		t.Fatal(err)
	}
	if id, busy := x.IndexBusy("/wt"); !busy || id != "j1" {
		t.Fatalf("IndexBusy = %q,%v", id, busy)
	}
	if id, busy := x.CommonBusy("/main/.git"); !busy || id != "j1" {
		t.Fatalf("CommonBusy = %q,%v", id, busy)
	}
	// 같은 common dir 의 다른 worktree 에서 fetch 는 common 칸이 막는다.
	if err := x.claim(Keys{Top: "/other", Common: "/main/.git"}, SlotsOf("fetch"), "j2"); !errors.Is(err, ErrJobBusy) {
		t.Fatalf("같은 common dir fetch err = %v, want ErrJobBusy", err)
	}
	// 실패한 claim 은 아무 칸도 차지하지 않는다.
	if _, busy := x.IndexBusy("/other"); busy {
		t.Fatal("실패한 claim 이 칸을 남겼다")
	}
	x.free(k, SlotsOf("pull"), "j1")
	if _, busy := x.IndexBusy("/wt"); busy {
		t.Fatal("free 뒤에도 index 칸이 찼다")
	}
	if _, busy := x.CommonBusy("/main/.git"); busy {
		t.Fatal("free 뒤에도 common 칸이 찼다")
	}
}

func TestSlotsOf(t *testing.T) {
	cases := map[string][]string{
		"pull":      {SlotIndex, SlotCommon},
		"fetch":     {SlotCommon},
		"push":      {SlotCommon},
		"submodule": {SlotCommon},
		"worktree":  {SlotCommon},
		"commit":    {SlotIndex},
		"merge":     {SlotIndex},
	}
	for kind, want := range cases {
		got := SlotsOf(kind)
		if len(got) != len(want) {
			t.Fatalf("%s: %v, want %v", kind, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("%s: %v, want %v", kind, got, want)
			}
		}
	}
}

// §5.4: pull 은 두 칸을 차지하고, 끝나면 두 칸을 비운다. Active 는 한 번만 준다.
func TestJobStart_PullHoldsBothSlots(t *testing.T) {
	started := make(chan struct{})
	x := NewExclusion()
	j := NewJobs(jobSvc(), WithJobRunner(jobBlockRunner(started)), WithExclusion(x))
	k := Keys{Top: absWorkA, Common: absWorkRepo}
	jb, err := j.Start(absWorkA, k, "pull", core.WriteSpec{Argv: []string{"pull", "--progress"}})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if _, busy := x.IndexBusy(absWorkA); !busy {
		t.Fatal("pull 이 index 칸을 차지하지 않았다")
	}
	if _, err := j.Start(absWorkB, Keys{Top: absWorkB, Common: absWorkRepo}, "fetch", jobFetchSpec()); !errors.Is(err, ErrJobBusy) {
		t.Fatalf("같은 common dir fetch err = %v, want ErrJobBusy", err)
	}
	if n := len(j.Active()); n != 1 {
		t.Fatalf("Active = %d, want 1 (pull 은 한 번)", n)
	}
	j.Cancel(jb.ID)
	jobWait(t, j, jb.ID, 2*time.Second)
	if _, busy := x.IndexBusy(absWorkA); busy {
		t.Fatal("끝난 pull 이 index 칸을 남겼다")
	}
	if _, busy := x.CommonBusy(absWorkRepo); busy {
		t.Fatal("끝난 pull 이 common 칸을 남겼다")
	}
}

// §5.4: fetch·push 는 common 칸만 차지한다 — index 칸은 비어 동기 쓰기가 돈다.
func TestJobStart_FetchLeavesIndexSlotFree(t *testing.T) {
	started := make(chan struct{})
	x := NewExclusion()
	j := NewJobs(jobSvc(), WithJobRunner(jobBlockRunner(started)), WithExclusion(x))
	jb, err := j.Start(absWorkA, Keys{Top: absWorkA, Common: absWorkRepo}, "fetch", jobFetchSpec())
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if _, busy := x.IndexBusy(absWorkA); busy {
		t.Fatal("fetch 가 index 칸을 차지했다")
	}
	j.Cancel(jb.ID)
	jobWait(t, j, jb.ID, 2*time.Second)
}
