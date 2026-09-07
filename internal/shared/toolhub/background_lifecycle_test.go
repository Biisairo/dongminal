package toolhub

import (
	"testing"
	"time"
)

// UX_BATCH6_SRS 묶음 B — 백그라운드 목록은 **살아 있는 프로세스의 목록**이다
// (FR-BGP-1·2·3·4).

// V-BGP-1 (FR-BGP-1·2): 도구가 죽으면 목록에서 빠지고 그 사실이 알려진다.
//
// 알림이 요구인 이유는 접수 ⑮다 — 다른 브라우저의 배지는 SSE 재연결 전까지
// 낡은 수를 보인다.
func TestDelete_DropsFromBackgroundAndNotifies(t *testing.T) {
	m := newTestManager(t)
	got := make(chan struct{}, 4)
	m.SetBackgroundChanged(func() { got <- struct{}{} })

	p, err := m.Create(t.TempDir(), 80, 24, Placement{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !m.SetBackground(p.ID, true) {
		t.Fatal("백그라운드로 보내지 못했다")
	}
	// FR-BGP-2: 보냄·되돌림은 HTTP 종단이 알린다 — 이 훅은 **죽음만** 낸다.
	select {
	case <-got:
		t.Fatal("SetBackground 가 훅을 냈다 — 그 자리는 종단의 몫이다")
	case <-time.After(100 * time.Millisecond):
	}

	m.Delete(p.ID)
	if m.IsBackground(p.ID) {
		t.Fatal("죽은 도구가 목록에 남았다")
	}
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("죽음이 알려지지 않았다 — 다른 브라우저의 배지가 낡은 채로 남는다")
	}
}

// 백그라운드가 아니었던 도구의 죽음은 목록을 바꾸지 않는다 — 알릴 것이 없다.
func TestDelete_NoNotifyForNonBackgroundTool(t *testing.T) {
	m := newTestManager(t)
	fired := make(chan struct{}, 1)
	m.SetBackgroundChanged(func() { fired <- struct{}{} })
	p, err := m.Create(t.TempDir(), 80, 24, Placement{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	m.Delete(p.ID)
	select {
	case <-fired:
		t.Fatal("목록이 바뀌지 않았는데 알렸다")
	case <-time.After(150 * time.Millisecond):
	}
}

// V-BGP-3 (FR-BGP-3·4): 명령으로 띄운 도구는 **그 명령이 프로세스**다.
// 명령이 끝나면 도구가 죽고, 죽으면 목록에서 사라진다.
func TestCreate_CommandIsTheProcess(t *testing.T) {
	m := newTestManager(t)
	gone := make(chan string, 2)
	m.SetInvalidator(func(id string) { gone <- id })

	p, err := m.Create(t.TempDir(), 80, 24, Placement{Command: "exit 0"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// FR-SBX-27 과 갈라져야 한다 — 명령으로 띄운 도구는 샌드박스가 아니므로
	// 백그라운드로 갈 수 있다. 그 도구는 백그라운드에 살라고 만든 것이다.
	if !m.SetBackground(p.ID, true) {
		t.Fatal("명령 도구를 백그라운드로 보내지 못했다 — 샌드박스로 오인했다")
	}
	select {
	case id := <-gone:
		if id != p.ID {
			t.Fatalf("다른 도구가 죽었다: %s", id)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("명령이 끝났는데 도구가 살아 있다")
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !m.IsBackground(p.ID) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("끝난 명령의 도구가 백그라운드 목록에 남았다")
}

// 명령을 주지 않으면 종전대로 대화형 셸이다 — 그때의 동작은 이 인자가 없던 때와
// 완전히 같아야 한다 (FR-BGP-5).
func TestCreate_NoCommandKeepsShell(t *testing.T) {
	m := newTestManager(t)
	p, err := m.Create(t.TempDir(), 80, 24, Placement{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// 이 검사만 셸을 살려 둔 채 끝난다 — Windows 에서는 그 프로세스의 cwd 가
	// `t.TempDir()` 을 붙들어 정리(RemoveAll)가 실패하고, 그 실패가 곧 검사의
	// 실패다 (CI 실측). defer 는 TempDir 의 cleanup 보다 먼저 돈다.
	defer m.Delete(p.ID)
	time.Sleep(400 * time.Millisecond)
	if !m.IsLive(p.ID) {
		t.Fatal("셸이 곧바로 죽었다")
	}
}
