package toolhub

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// CODE_AUDIT_FIXES_SRS 묶음 D — SaveAll 이 낡은 상태로 최신을 덮는 경쟁
// (V-CAF-11).
//
// **왜 문제인가.** `saveAsync` 는 호출마다 고루틴을 띄운다. 그런데 SaveAll 자신에
// 직렬화가 없으면, 스냅샷 시각이 A→B 인 두 저장이 디스크에는 B→A 순으로 도착할 수
// 있다 — 그러면 **낡은 tools.json 이 최종본이 된다.** 도구를 빠르게 여닫을 때
// 실제로 생기는 순서다.
//
// 이 저장소는 같은 문제를 이미 풀었다 — workspace.Manager 의 writer() 가 단일
// writer 로 순서를 보장한다. toolhub 에만 그것이 없었다.

// V-CAF-11 (FR-CAF-12): SaveAll 은 동시에 하나만 돈다.
//
// 관측 지점은 ownedTools 콜백이다. SaveAll 이 스냅샷을 뜬 **뒤** 디스크에 쓰기
// **전에** 부르므로, 여기서 둘이 겹치는 것이 보이면 스냅샷과 쓰기 사이가 열려
// 있다는 뜻이다.
func TestSaveAllIsSerialized(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	m.mutated.Store(true)

	var inFlight, peak atomic.Int32
	m.SetOwnedTools(func() map[string]struct{} {
		n := inFlight.Add(1)
		for {
			old := peak.Load()
			if n <= old || peak.CompareAndSwap(old, n) {
				break
			}
		}
		// 겹칠 창을 실제로 벌린다 — 직렬화가 없으면 여기서 반드시 겹친다.
		time.Sleep(5 * time.Millisecond)
		inFlight.Add(-1)
		return nil
	})

	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() { defer wg.Done(); m.SaveAll() }()
	}
	wg.Wait()

	if got := peak.Load(); got != 1 {
		t.Fatalf("SaveAll 이 %d개 동시에 돌았다 — 디스크 도착 순서를 보장할 수 없다 (FR-CAF-12 위반)", got)
	}
}

// 직렬화가 저장을 잃지 않는지 — 잠금을 걸면서 호출을 버리면 마지막 상태가
// 디스크에 닿지 않는다.
func TestSaveAllRunsEveryCall(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	m.mutated.Store(true)

	var calls atomic.Int32
	m.SetOwnedTools(func() map[string]struct{} {
		calls.Add(1)
		return nil
	})

	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() { defer wg.Done(); m.SaveAll() }()
	}
	wg.Wait()

	if got := calls.Load(); got != 5 {
		t.Fatalf("SaveAll 5회 중 %d회만 돌았다 — 저장을 버렸다", got)
	}
}

// FR-OPT-5-3 (SHR-6): 저장 요청은 latest-wins 로 합쳐진다.
//
// 저장 하나가 도는 동안 요청이 N 개 쌓여도 뒤따르는 저장은 **하나**다 — 그 하나가
// 쌓인 요청 전부의 최신 상태를 쓴다. 요청마다 고루틴·lsof·fsync 를 치르지 않는다.
func TestSaveAsyncCoalescesWhileSaving(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	m.mutated.Store(true)

	var calls atomic.Int32
	entered := make(chan struct{}, 16)
	release := make(chan struct{})
	m.SetOwnedTools(func() map[string]struct{} {
		if calls.Add(1) == 1 {
			entered <- struct{}{}
			<-release
		}
		return nil
	})

	m.saveAsync()
	<-entered
	const queued = 10
	for range queued {
		m.saveAsync()
	}
	close(release)
	m.StopSaving()

	// 첫 저장 1 + 쌓인 10 을 합친 1.
	if got := calls.Load(); got != 2 {
		t.Fatalf("저장 %d회 — 비행 중 요청 %d개가 합쳐지지 않았다 (want 2)", got, queued)
	}
}

// 합치기가 요청을 잃지 않는다 — 비행 중에 들어온 요청은 비행이 끝난 뒤 반드시
// 한 번 더 저장된다.
func TestSaveAsyncRunsTrailingSave(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	m.mutated.Store(true)

	var calls atomic.Int32
	entered := make(chan struct{}, 4)
	release := make(chan struct{})
	m.SetOwnedTools(func() map[string]struct{} {
		if calls.Add(1) == 1 {
			entered <- struct{}{}
			<-release
		}
		return nil
	})
	m.saveAsync()
	<-entered
	m.saveAsync()
	close(release)
	m.StopSaving()
	if got := calls.Load(); got != 2 {
		t.Fatalf("저장 %d회 want 2 — 비행 중 요청을 버렸다", got)
	}
	m.saveAsync()
	if got := calls.Load(); got != 2 {
		t.Fatalf("StopSaving 뒤에 저장이 시작됐다 (%d회)", got)
	}
}
