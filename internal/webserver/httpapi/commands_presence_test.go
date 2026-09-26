package httpapi

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"dongminal/internal/webserver/hub"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-4-12 · D-OPT-4 — 칸 SSE 의 `presence=1`.
//
// 소유권 수명(FR-XDF-9)만 쥐고 방송을 싣지 않는다. 인사(keepalive)는 그대로 온다.

func TestSSE_PresenceHoldsOwnershipWithoutBroadcast(t *testing.T) {
	f := &fakeUpdates{}
	cmd := hub.NewCommandHub()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Commands: cmd, Updates: f})
	if err != nil {
		t.Fatal(err)
	}
	srv.helloEvery = 50 * time.Millisecond
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/commands/sse?clientId=slotA&presence=1", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	lines := make(chan string, 64)
	go func() {
		sc := bufio.NewScanner(resp.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	waitLine := func(want string) {
		t.Helper()
		deadline := time.After(3 * time.Second)
		for {
			select {
			case l, ok := <-lines:
				if !ok {
					t.Fatalf("스트림이 %q 없이 끝났다", want)
				}
				if strings.Contains(l, "broadcast-probe") {
					t.Fatal("presence 구독이 방송을 받았다")
				}
				if strings.Contains(l, want) {
					return
				}
			case <-deadline:
				t.Fatalf("%q 를 받지 못했다", want)
			}
		}
	}
	waitLine("server_hello")

	if srv.Focus.LiveCount() != 1 {
		t.Fatalf("presence 구독이 소유권 수명을 쥐지 않았다 (live=%d)", srv.Focus.LiveCount())
	}
	if n := cmd.Broadcast([]byte(`{"action":"broadcast-probe"}`)); n != 0 {
		t.Fatalf("presence 구독이 방송 대상에 들었다 (delivered=%d)", n)
	}
	// keepalive 인사는 계속 온다 — 그 사이에 방송이 끼어들면 waitLine 이 잡는다.
	waitLine("server_hello")
	waitLine("server_hello")

	// 판 확인은 화면 구독의 몫이다 — 칸 구독은 걸지 않는다.
	full := openSSE(t, ts, "main")
	defer full.Body.Close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && f.triggers.Load() < 1 {
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	if n := f.triggers.Load(); n != 1 {
		t.Fatalf("판 확인 %d회 — presence 구독은 걸지 않아야 한다", n)
	}

	cancel()
	deadline = time.Now().Add(3 * time.Second)
	for srv.Focus.LiveCount() != 1 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if srv.Focus.LiveCount() != 1 {
		t.Fatalf("presence 구독을 닫았는데 소유권 수명이 남았다 (live=%d)", srv.Focus.LiveCount())
	}
}

// 파라미터가 없으면 종전과 같다 — 방송을 받는다 (옛 브라우저·칸 0).
func TestSSE_WithoutPresenceStillBroadcast(t *testing.T) {
	_, cmd, ts := sseServer(t)
	resp := openSSE(t, ts, "full")
	defer resp.Body.Close()
	if n := cmd.Broadcast([]byte(`{"action":"x"}`)); n != 1 {
		t.Fatalf("delivered=%d want 1", n)
	}
}

// 04-secops P1-4: presence 구독도 상한 안에 있다 — 방송 구독을 만들지 않는다고
// 연결을 여는 것만으로 goroutine 을 무한히 세울 수 있으면 안 된다.
func TestSSE_PresenceSubCap(t *testing.T) {
	_, _, ts := sseServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	open := func(i int) string {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/commands/sse?presence=1&clientId=p"+strconv.Itoa(i), nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { resp.Body.Close() })
		buf := make([]byte, 256)
		n, _ := resp.Body.Read(buf)
		return string(buf[:n])
	}
	for i := 0; i < hub.SubCap; i++ {
		if got := open(i); strings.Contains(got, "subscribeRejected") {
			t.Fatalf("상한 안(%d/%d)인데 거절됐다", i, hub.SubCap)
		}
	}
	if got := open(hub.SubCap); !strings.Contains(got, "subscribeRejected") {
		t.Fatalf("상한을 넘긴 presence 구독이 열렸다: %q", got)
	}
}
