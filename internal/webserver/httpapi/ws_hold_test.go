package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/toolhub"

	"github.com/gorilla/websocket"
)

// CONNECTIVITY_RESILIENCE_SRS 묶음 A — 폭주의 종식 (V-CNR-1~6).
//
// **왜 붙잡는가.** `onclose` 가 클라이언트에서 재연결의 유일한 계기다
// (`term-pane.js:351·356`). 그러므로 소켓을 닫는 한 재연결은 반드시 다시 온다 —
// 지연은 주기를 늘릴 뿐 고리를 끊지 못하고, 거절은 오히려 주기를 줄인다 (§2.2).
// 고리를 끊는 자리는 **닫지 않는 것** 하나뿐이다 (D-2).

// V-CNR-6 (FR-CNR-1): 창 안의 횟수를 센다. 지금까지는 마지막 시각만 기억해
// "되풀이인가" 만 답했다 — 임계를 두려면 횟수가 있어야 한다.
func TestMissTrackerCountsWithinWindow(t *testing.T) {
	var mt missTracker
	base := time.Unix(100, 0)
	for i := 1; i <= 4; i++ {
		if got := mt.count("tool-a", base.Add(time.Duration(i)*time.Millisecond)); got != i {
			t.Fatalf("%d번째 미스의 count = %d, want %d", i, got, i)
		}
	}
}

// V-CNR-6 (FR-CNR-1): 창을 지나면 횟수가 초기화된다. 오래 뒤에 온 정상 요청이
// 옛 폭주의 횟수를 물려받으면 안 된다.
func TestMissTrackerCountResetsAfterWindow(t *testing.T) {
	var mt missTracker
	base := time.Unix(100, 0)
	for i := 0; i < 10; i++ {
		mt.count("tool-a", base.Add(time.Duration(i)*time.Millisecond))
	}
	if got := mt.count("tool-a", base.Add(MissRepeatWindow+time.Second)); got != 1 {
		t.Fatalf("창을 지난 미스의 count = %d, want 1", got)
	}
}

// 도구마다 따로 센다 — 한 도구의 폭주가 다른 도구를 붙잡으면 안 된다.
func TestMissTrackerCountIsPerTool(t *testing.T) {
	var mt missTracker
	base := time.Unix(100, 0)
	for i := 0; i < 5; i++ {
		mt.count("tool-a", base.Add(time.Duration(i)*time.Millisecond))
	}
	if got := mt.count("tool-b", base.Add(6*time.Millisecond)); got != 1 {
		t.Fatalf("다른 도구의 count = %d, want 1", got)
	}
}

// V-CNR-1 (FR-CNR-5): 임계 이하는 붙잡지 않는다. 규약을 지키는 클라이언트는
// 첫 통보 한 번으로 판정을 끝내므로(FR-RCS-1) 그들에게는 아무것도 바뀌지 않는다.
func TestHoldMissBelowThreshold(t *testing.T) {
	s := &Server{}
	for i := 1; i < MissHoldAfter; i++ {
		if s.holdMiss(context.Background(), "tool-a", nil) {
			t.Fatalf("%d번째 미스에서 붙잡았다 — 임계는 %d다", i, MissHoldAfter)
		}
	}
}

// V-CNR-2 (FR-CNR-2): 임계를 넘으면 붙잡는다. 붙잡기는 컨텍스트가 끝날 때까지
// 돌아오지 않는다 — 그 사이 소켓이 닫히지 않는 것이 방어의 실체다.
func TestHoldMissAboveThresholdHolds(t *testing.T) {
	s := &Server{}
	ctx, cancel := context.WithCancel(context.Background())
	// 임계까지 올린다. 여기까지는 붙잡지 않는다.
	for i := 1; i < MissHoldAfter; i++ {
		s.holdMiss(ctx, "tool-a", nil)
	}

	done := make(chan bool, 1)
	go func() { done <- s.holdMiss(ctx, "tool-a", nil) }()

	// 붙잡는 중이라면 돌아오지 않는다.
	select {
	case <-done:
		t.Fatal("임계를 넘었는데 즉시 돌아왔다 — 붙잡지 않았다")
	case <-time.After(50 * time.Millisecond):
	}

	cancel()
	select {
	case held := <-done:
		if !held {
			t.Fatal("붙잡았다고 답하지 않았다")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("취소했는데 붙잡기가 풀리지 않았다")
	}
}

// V-CNR-4 (FR-CNR-3): 컨텍스트가 끝나면 **즉시** 풀린다. 서버 종료가 10분짜리
// 붙잡기에 발목잡히면 안 된다.
func TestHoldMissReleasesOnContextCancel(t *testing.T) {
	s := &Server{}
	for i := 1; i < MissHoldAfter; i++ {
		s.holdMiss(context.Background(), "tool-a", nil)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	start := time.Now()
	if !s.holdMiss(ctx, "tool-a", nil) {
		t.Fatal("임계를 넘었는데 붙잡지 않았다")
	}
	if el := time.Since(start); el > time.Second {
		t.Fatalf("취소된 컨텍스트인데 %v 를 기다렸다 — FR-CNR-3 위반", el)
	}
}

// V-CNR-5 (FR-CNR-4): 동시 붙잡기가 상한을 넘으면 붙잡지 않는다. 상한이 없으면
// 방어가 새로운 고갈이 된다.
func TestHoldMissRespectsLimit(t *testing.T) {
	s := &Server{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 상한만큼을 붙잡아 둔다. 각 도구를 임계 위로 올린 뒤 고루틴으로 붙잡는다.
	started := make(chan struct{}, MissHoldLimit)
	for i := 0; i < MissHoldLimit; i++ {
		id := "tool-" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		for k := 1; k < MissHoldAfter; k++ {
			s.holdMiss(ctx, id, nil)
		}
		go func(id string) { started <- struct{}{}; s.holdMiss(ctx, id, nil) }(id)
		<-started
	}
	// 붙잡기들이 자리를 잡을 시간을 준다.
	deadline := time.Now().Add(2 * time.Second)
	for s.holds.Load() < int64(MissHoldLimit) && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := s.holds.Load(); got < int64(MissHoldLimit) {
		t.Fatalf("붙잡은 수 = %d, want %d", got, MissHoldLimit)
	}

	// 상한을 넘는 하나는 붙잡지 못하고 즉시 돌아온다.
	over := "tool-over"
	for k := 1; k < MissHoldAfter; k++ {
		s.holdMiss(ctx, over, nil)
	}
	start := time.Now()
	if s.holdMiss(ctx, over, nil) {
		t.Fatal("상한을 넘었는데 붙잡았다 — FR-CNR-4 위반")
	}
	if el := time.Since(start); el > time.Second {
		t.Fatalf("붙잡지 않았는데 %v 를 기다렸다", el)
	}
}

// FR-CNR-4: 붙잡기가 풀리면 자리가 반납된다 — 그러지 않으면 상한이 한 번 차고
// 영영 돌아오지 않는다.
func TestHoldMissReleasesSlot(t *testing.T) {
	s := &Server{}
	for i := 1; i < MissHoldAfter; i++ {
		s.holdMiss(context.Background(), "tool-a", nil)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	s.holdMiss(ctx, "tool-a", nil)
	if got := s.holds.Load(); got != 0 {
		t.Fatalf("붙잡기가 끝났는데 자리가 %d 남았다", got)
	}
}

// FR-CNR-6 (개정): 붙잡는 동안 **연결이 끊기면 즉시 푼다.**
//
// 이것은 실측으로 드러난 결함이다. upgrade 로 hijack 된 뒤에는 `r.Context()` 가
// 클라이언트 절단으로 취소되지 않아, curl 이 끊은 뒤에도 `hold=4` 가 그대로
// 남았다. 그러면 닫힌 탭이 10분씩 자리를 먹고 상한(64)이 차서 방어가 무력해진다.
// 읽기만이 절단을 알려준다.
func TestHoldMissReleasesWhenPeerDisconnects(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := toolhub.Upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		conn := toolhub.NewSafeConn(raw)
		defer conn.Close()
		s := &Server{}
		// 임계까지 올린 뒤 붙잡는다. 소켓이 살아 있는 한 돌아오지 않아야 하고,
		// 끊기면 그때 돌아와야 한다.
		for i := 1; i < MissHoldAfter; i++ {
			s.holdMiss(context.Background(), "tool-a", nil)
		}
		start := time.Now()
		s.holdMiss(context.Background(), "tool-a", conn)
		if el := time.Since(start); el > 5*time.Second {
			t.Errorf("피어가 끊었는데 %v 를 붙잡았다 — FR-CNR-6 위반", el)
		}
	}))
	defer srv.Close()

	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	// 붙잡기가 자리를 잡을 시간을 준 뒤 끊는다.
	time.Sleep(100 * time.Millisecond)
	c.Close()
	// 핸들러가 끝나기를 기다린다 — Close() 가 그것을 기다려 준다.
}
