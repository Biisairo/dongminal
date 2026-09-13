package toolhub

import (
	"errors"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
)

// blockingStart 는 StartTool 자리에 꽂는 가짜다 — release 가 닫힐 때까지 기동
// 안에서 멈춘다. Create 가 그동안 레지스트리 잠금을 쥐고 있는지가 판정 대상이다.
func blockingStart(release <-chan struct{}) startToolFunc {
	return func(id, name, cwd string, cols, rows uint16, onExit func(string), hooks *ToolHooks, place *platform.ProcSpec) (*Tool, error) {
		<-release
		return NewDetachedTool(id, hooks), nil
	}
}

// M8 `GO-29`: Create 는 StartTool(fork/exec + PTY open) 을 잠금 **밖에서** 돈다.
// 종전에는 쓰기 잠금을 쥔 채 띄웠고, 그동안 Get/List/IsLive 가 전부 대기했다.
func TestToolManager_CreateStartsOutsideLock(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	release := make(chan struct{})
	m.startTool = blockingStart(release)

	created := make(chan error, 1)
	go func() {
		_, err := m.Create("", 80, 24, Placement{})
		created <- err
	}()
	// Create 가 기동 안에 들어갈 때까지 기다린다 — 예약이 잡힌 것이 그 신호다.
	deadline := time.Now().Add(2 * time.Second)
	for {
		m.mu.RLock()
		n := m.pending
		m.mu.RUnlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Create 가 기동에 들어가지 않았다")
		}
		time.Sleep(time.Millisecond)
	}

	listed := make(chan struct{})
	go func() {
		m.List()
		m.Get("nope")
		close(listed)
	}()
	select {
	case <-listed:
	case <-time.After(2 * time.Second):
		t.Fatal("기동 중인 Create 가 List/Get 을 막고 있다")
	}
	close(release)
	if err := <-created; err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(m.List()) != 1 {
		t.Fatalf("등록되지 않았다: %d", len(m.List()))
	}
}

// 잠금 밖에서 띄워도 상한은 지켜진다 — 자리를 **잠금 안에서 예약**하고 띄운다.
// 예약 없이 세면 동시 요청 여럿이 같은 값을 보고 함께 통과한다 (04-secops P1-4).
func TestToolManager_CreateReservesCapBeforeStart(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	release := make(chan struct{})
	m.startTool = blockingStart(release)

	var wg sync.WaitGroup
	errs := make(chan error, ToolCap)
	for i := 0; i < ToolCap; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := m.Create("", 80, 24, Placement{})
			errs <- err
		}()
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		m.mu.RLock()
		n := m.pending
		m.mu.RUnlock()
		if n == ToolCap {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("예약이 %d 에 머문다 (want %d)", n, ToolCap)
		}
		time.Sleep(time.Millisecond)
	}
	// 전부 기동 중(아직 등록 전)인데도 하나 더는 즉시 거절된다.
	if _, err := m.Create("", 80, 24, Placement{}); !errors.Is(err, ErrToolCap) {
		t.Fatalf("상한 초과가 거절되지 않았다: %v", err)
	}
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("create: %v", err)
		}
	}
	if got := len(m.List()); got != ToolCap {
		t.Fatalf("등록 %d != %d", got, ToolCap)
	}
}

// 기동이 실패하면 예약을 돌려준다 — 그러지 않으면 실패가 쌓여 상한이 잠긴다.
func TestToolManager_CreateReleasesReservationOnFailure(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	boom := errors.New("boom")
	m.startTool = func(string, string, string, uint16, uint16, func(string), *ToolHooks, *platform.ProcSpec) (*Tool, error) {
		return nil, boom
	}
	if _, err := m.Create("", 80, 24, Placement{}); !errors.Is(err, boom) {
		t.Fatalf("err=%v", err)
	}
	m.mu.RLock()
	n := m.pending
	m.mu.RUnlock()
	if n != 0 {
		t.Fatalf("실패 뒤 예약이 남았다: %d", n)
	}
}

// M8 `GO-30`: 도구 종료 콜백은 invalidator 를 **잠금으로** 읽는다. SetInvalidator
// 는 잠금으로 쓰는데 읽는 쪽이 맨 읽기였다 — -race 가 판정한다.
func TestToolManager_ExitReadsInvalidatorUnderLock(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	t.Cleanup(m.StopSaving)
	var onExit func(string)
	m.startTool = func(id, name, cwd string, cols, rows uint16, exit func(string), hooks *ToolHooks, place *platform.ProcSpec) (*Tool, error) {
		onExit = exit
		return NewDetachedTool(id, hooks), nil
	}
	p, err := m.Create("", 80, 24, Placement{})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	invalidated := make(chan string, 8)
	stop := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				m.SetInvalidator(func(id string) {
					select {
					case invalidated <- id:
					default:
					}
				})
			}
		}
	}()
	onExit(p.ID)
	close(stop)
	wg.Wait()
	if m.Get(p.ID) != nil {
		t.Fatal("종료 콜백이 도구를 지우지 않았다")
	}
}
