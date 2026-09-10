package httpapi

import (
	"net/http/httptest"
	"testing"
	"time"

	"dongminal/internal/webserver/hub"
)

// GIT_WATCH_LEASE_SRS §4.2 — 임대의 배선 (TC-GWL-9·10).
//
// 여기서 재는 것은 계약이 아니라 **배선**이다. 계약은 `hub/gitwatch_test.go` 가
// 이미 다 재고, 이 파일이 없으면 그 계약이 아무 데도 연결되지 않은 채로 초록일
// 수 있다 — GP-1 이 오래 살아남은 방식이 정확히 그것이다(화면은 멀쩡히 서고,
// 안전망을 끈 사용자에게서만 90초 뒤에 갱신이 멎는다).

func leaseTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// git 배선이 없는 구성이라 `New` 가 감시자를 만들지 않는다. 재는 것은
	// 구독↔임대의 결선이므로 관측자 없는 감시자로 충분하다.
	srv.gitWatch = hub.NewGitWatcher(nil, nil)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts
}

// waitLeases 는 임대 수가 want 가 될 때까지 기다린다. 구독 해제는 서버 고루틴에서
// 일어나므로 폴링이 필요하다 (`waitOwner` 와 같은 이유).
func waitLeases(t *testing.T, srv *Server, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	got := -1
	for time.Now().Before(deadline) {
		got = srv.gitWatch.Leases()
		if got == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("임대 수 %d, 기대 %d (FR-GWL-3)", got, want)
}

// TC-GWL-9: clientId 를 실은 SSE 를 열면 임대가 생기고, 끊으면 사라진다.
func TestGitWatchLease_AttachesAndDetachesWithSSE(t *testing.T) {
	srv, ts := leaseTestServer(t)

	resp := openSSE(t, ts, "c1")
	waitLeases(t, srv, 1)

	resp.Body.Close()
	waitLeases(t, srv, 0)
}

// TC-GWL-10: clientId 없는 구독은 임대를 만들지 않는다.
//
// 종전 호출 형태의 하위 호환이다 — 신원을 밝히지 않은 연결은 "이 저장소를
// 본다" 를 주장할 수 없고, 그런 표명은 종전대로 TTL 임대로 떨어진다 (FR-GWL-5).
func TestGitWatchLease_AnonymousSubscriptionHoldsNothing(t *testing.T) {
	srv, ts := leaseTestServer(t)

	resp := openSSE(t, ts, "")
	defer resp.Body.Close()

	// `openSSE` 가 ": connected" 까지 읽고 돌아온다 — 핸들러가 구독 등록 구간을
	// 이미 지났다는 뜻이다. 그러므로 여기서 0 이면 "아직 안 걸린 것" 이 아니라
	// "걸지 않은 것" 이다.
	if n := srv.gitWatch.Leases(); n != 0 {
		t.Fatalf("익명 구독이 임대를 얻었다: %d (FR-GWL-10)", n)
	}
}
