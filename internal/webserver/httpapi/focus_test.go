package httpapi

import (
	"dongminal/internal/webserver/hub"

	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/testpath"
)

// 묶음 E — 창 포커스 소유권 (SRS §3.5 FR-XDF-*, §4.5 TC-XDF-*)
//
// e2e 로 볼 수 없는 두 요구만 여기서 검증한다 — 구독 종료 시 해제(FR-XDF-9)와
// 재연결 경합 보호(FR-XDF-10). 나머지는 e2e/focus-owner.spec.ts 에 있다.

func focusTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return srv, ts
}

// openSSE 는 clientId 를 실은 SSE 구독을 열고, 서버가 구독을 등록한 뒤 돌아온다.
func openSSE(t *testing.T, ts *httptest.Server, clientID string) *http.Response {
	t.Helper()
	resp, err := http.Get(ts.URL + "/api/commands/sse?clientId=" + clientID)
	if err != nil {
		t.Fatalf("GET SSE: %v", err)
	}
	buf := make([]byte, 64)
	if _, err := resp.Body.Read(buf); err != nil { // ": connected" 까지 읽어 등록을 보장
		t.Fatalf("SSE read: %v", err)
	}
	return resp
}

// waitOwner 는 windowID 의 소유자가 want 가 될 때까지 기다린다. 구독 해제는
// 서버 고루틴에서 일어나므로 폴링이 필요하다 ("" = 소유자 없음).
func waitOwner(t *testing.T, srv *Server, windowID, want string) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	var got string
	for time.Now().Before(deadline) {
		got = srv.Focus.Snapshot()[windowID]
		if got == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("owner[%s]=%q want %q", windowID, got, want)
}

func claimHTTP(t *testing.T, ts *httptest.Server, clientID, windowID string) {
	t.Helper()
	body := `{"clientId":` + testpath.JSONQuote(clientID) + `,"windowId":` + testpath.JSONQuote(windowID) + `}`
	resp, err := http.Post(ts.URL+"/api/focus/claim", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST claim: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("claim status=%d want 200", resp.StatusCode)
	}
}

// TC-XDF-12 (FR-XDF-9): 구독이 끊기면 소유권이 즉시 해제된다.
func TestFocus_SubscriptionCloseReleasesOwnership(t *testing.T) {
	srv, ts := focusTestServer(t)

	sse := openSSE(t, ts, "cliA")
	claimHTTP(t, ts, "cliA", "W1")
	waitOwner(t, srv, "W1", "cliA")

	sse.Body.Close()
	waitOwner(t, srv, "W1", "")
}

// TC-XDF-11 (FR-XDF-10): 같은 clientId 로 구독 2개를 연 뒤 **먼저 연 것**을 닫으면
// 소유권이 유지된다. 이 보호가 없으면 재연결 직후 새 구독의 획득이 옛 구독의
// 지연된 teardown 에 덮여 소유권이 사라진다.
func TestFocus_StaleSubscriptionCloseKeepsOwnership(t *testing.T) {
	srv, ts := focusTestServer(t)

	older := openSSE(t, ts, "cliA")
	newer := openSSE(t, ts, "cliA")
	defer newer.Body.Close()

	claimHTTP(t, ts, "cliA", "W1")
	waitOwner(t, srv, "W1", "cliA")

	older.Body.Close()

	// 옛 구독의 teardown 이 소유권을 건드리지 않아야 한다. 해제가 일어난다면
	// 그것은 비동기이므로 잠시 기다린 뒤 확인한다.
	time.Sleep(300 * time.Millisecond)
	if got := srv.Focus.Snapshot()["W1"]; got != "cliA" {
		t.Fatalf("owner[W1]=%q want cliA — 옛 구독의 teardown 이 소유권을 해제했다", got)
	}

	// 최신 구독이 닫히면 그때 해제된다.
	newer.Body.Close()
	waitOwner(t, srv, "W1", "")
}

// FR-XDF-3: 한 Client 는 한 Window 만 소유한다.
func TestFocus_ClaimReleasesPreviousWindow(t *testing.T) {
	f := hub.NewFocusRegistry()
	if !f.Claim("cliA", "W1") {
		t.Fatal("첫 획득이 변화 없음으로 보고됐다")
	}
	if !f.Claim("cliA", "W2") {
		t.Fatal("Window 이동이 변화 없음으로 보고됐다")
	}
	snap := f.Snapshot()
	if _, ok := snap["W1"]; ok {
		t.Fatalf("W1 소유가 남아 있다: %v", snap)
	}
	if snap["W2"] != "cliA" {
		t.Fatalf("owner[W2]=%q want cliA", snap["W2"])
	}
}

// FR-XDF-2: last-focus-wins — 기존 소유자를 협상 없이 밀어낸다.
// FR-XDF-14: 같은 획득의 반복은 변화가 아니다 (브로드캐스트를 만들지 않는다).
func TestFocus_LastFocusWinsAndIdempotent(t *testing.T) {
	f := hub.NewFocusRegistry()
	f.Claim("cliA", "W1")
	if !f.Claim("cliB", "W1") {
		t.Fatal("소유자 교체가 변화 없음으로 보고됐다")
	}
	if f.Snapshot()["W1"] != "cliB" {
		t.Fatalf("owner[W1]=%q want cliB", f.Snapshot()["W1"])
	}
	if f.Claim("cliB", "W1") {
		t.Fatal("같은 획득의 반복이 변화로 보고됐다 — 불필요한 브로드캐스트를 낳는다")
	}
}

// Snapshot 은 복사본이어야 한다 — 호출자가 내부 맵을 들고 가면 잠금 밖에서
// 소유권을 수정할 수 있게 된다.
func TestFocus_SnapshotIsCopy(t *testing.T) {
	f := hub.NewFocusRegistry()
	f.Claim("cliA", "W1")
	snap := f.Snapshot()
	snap["W1"] = "tampered"
	delete(snap, "W1")
	if f.Snapshot()["W1"] != "cliA" {
		t.Fatal("Snapshot 이 내부 맵을 노출한다")
	}
}

// 빈 인자는 상태를 바꾸지 않는다.
func TestFocus_EmptyArgsAreNoops(t *testing.T) {
	f := hub.NewFocusRegistry()
	if f.Claim("", "W1") || f.Claim("cliA", "") {
		t.Fatal("빈 인자 획득이 변화로 보고됐다")
	}
	if f.Detach("cliA", 0) || f.Detach("", 1) {
		t.Fatal("빈 인자 해제가 변화로 보고됐다")
	}
	if len(f.Snapshot()) != 0 {
		t.Fatalf("상태가 오염됐다: %v", f.Snapshot())
	}
}

// clientId 없는 구독은 소유권 결선 없이 동작한다 (기존 호출 형태 하위 호환).
func TestFocus_SSEWithoutClientIdStillWorks(t *testing.T) {
	_, ts := focusTestServer(t)
	resp := openSSE(t, ts, "")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
}

// 잘못된 본문은 400 이다.
func TestFocus_ClaimRejectsBadBody(t *testing.T) {
	_, ts := focusTestServer(t)
	for _, body := range []string{`{bad`, `{}`, `{"clientId":"a"}`, `{"windowId":"W1"}`} {
		resp, err := http.Post(ts.URL+"/api/focus/claim", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("POST %s: %v", body, err)
		}
		resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatalf("body=%s status=%d want 400", body, resp.StatusCode)
		}
	}
}

// ── 실행자 선출 (WORKSPACE_IDENTITY_SRS FR-SXE-4/5) ──

// TC-SXE-1: live 구독이 없으면 지명하지 않는다 (FR-SXE-5).
func TestExecutor_NoLiveSubscriptionYieldsEmpty(t *testing.T) {
	f := hub.NewFocusRegistry()
	if got := f.Executor(); got != "" {
		t.Fatalf("Executor()=%q want \"\" — live 구독이 없다", got)
	}
	// 포커스만 주장하고 구독은 없는 경우에도 지명하지 않는다.
	f.Claim("cliA", "W1")
	if got := f.Executor(); got != "" {
		t.Fatalf("Executor()=%q want \"\" — 주장 이력만으로 지명해서는 안 된다", got)
	}
}

// TC-SXE-1: 주장 이력이 없으면 가장 오래된 live 구독을 쓴다 (FR-SXE-4 폴백).
func TestExecutor_FallsBackToOldestLiveSubscription(t *testing.T) {
	f := hub.NewFocusRegistry()
	f.Attach("cliA")
	f.Attach("cliB")
	f.Attach("cliC")
	if got := f.Executor(); got != "cliA" {
		t.Fatalf("Executor()=%q want cliA — 가장 오래된 구독이어야 한다", got)
	}
}

// TC-SXE-1: 가장 최근에 포커스를 주장한 live Client 가 실행자다 (FR-SXE-4).
func TestExecutor_PrefersMostRecentFocusClaimer(t *testing.T) {
	f := hub.NewFocusRegistry()
	f.Attach("cliA")
	f.Attach("cliB")
	f.Claim("cliB", "W1")
	if got := f.Executor(); got != "cliB" {
		t.Fatalf("Executor()=%q want cliB — 주장 이력이 구독 순서를 이긴다", got)
	}
	f.Claim("cliA", "W2")
	if got := f.Executor(); got != "cliA" {
		t.Fatalf("Executor()=%q want cliA — 더 최근 주장이 이긴다", got)
	}
	// 같은 주장을 반복해도 순서는 바뀌지 않는다 (Claim 이 변화 없음으로 보는 경로).
	f.Claim("cliB", "W1")
	if got := f.Executor(); got != "cliA" {
		t.Fatalf("Executor()=%q want cliA — 변화 없는 재주장이 순서를 바꿨다", got)
	}
}

// TC-SXE-1: 주장 이력이 있어도 live 가 아니면 후보가 아니다.
func TestExecutor_IgnoresClaimersThatAreNotLive(t *testing.T) {
	f := hub.NewFocusRegistry()
	f.Attach("cliA")
	ep := f.Attach("cliB")
	f.Claim("cliB", "W1")
	f.Detach("cliB", ep)
	if got := f.Executor(); got != "cliA" {
		t.Fatalf("Executor()=%q want cliA — 끊긴 Client 를 지명했다", got)
	}
}

// TC-SXE-2: 실행자가 끊기면 남은 live 중에서 다시 고른다.
func TestExecutor_ReelectsAfterDetach(t *testing.T) {
	f := hub.NewFocusRegistry()
	epA := f.Attach("cliA")
	f.Attach("cliB")
	f.Claim("cliA", "W1")
	if got := f.Executor(); got != "cliA" {
		t.Fatalf("Executor()=%q want cliA", got)
	}
	f.Detach("cliA", epA)
	if got := f.Executor(); got != "cliB" {
		t.Fatalf("Executor()=%q want cliB — 재선출되지 않았다", got)
	}
}

// 재연결(새 Attach)은 옛 epoch 의 Detach 로 무효화되지 않는다 — FR-XDF-10 과 같은 규칙.
func TestExecutor_StaleDetachDoesNotRemoveReattachedClient(t *testing.T) {
	f := hub.NewFocusRegistry()
	old := f.Attach("cliA")
	f.Attach("cliA") // 재연결
	f.Detach("cliA", old)
	if got := f.Executor(); got != "cliA" {
		t.Fatalf("Executor()=%q want cliA — 옛 구독의 teardown 이 후보에서 지웠다", got)
	}
}
