package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/updatecheck"
	"dongminal/internal/webserver/hub"
)

// fakeUpdates 는 판 확인의 접합면을 흉내낸다. **httpapi 는 GitHub 을 알지
// 않는다** — 그 사실을 이 가짜가 증명한다.
type fakeUpdates struct {
	snap     updatecheck.Snapshot
	triggers atomic.Int64
	sets     atomic.Int64
	setErr   error
}

func (f *fakeUpdates) Snapshot() updatecheck.Snapshot { return f.snap }
func (f *fakeUpdates) Trigger()                       { f.triggers.Add(1) }
func (f *fakeUpdates) SetEnabled(on bool) error {
	f.sets.Add(1)
	if f.setErr != nil {
		return f.setErr
	}
	f.snap.Enabled = on
	return nil
}

func updateServer(t *testing.T, u UpdateService) *httptest.Server {
	t.Helper()
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Commands: hub.NewCommandHub(), Updates: u})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// FR-UPD-7: 마지막 확인 결과를 그대로 낸다.
func TestUpdateGetReturnsSnapshot(t *testing.T) {
	f := &fakeUpdates{snap: updatecheck.Snapshot{
		Enabled: true, Current: "v1.0.0", Latest: "v1.2.0", Newer: true,
		Link: "https://example/rel", CheckedAt: "2026-09-16T00:00:00Z",
	}}
	ts := updateServer(t, f)
	res, err := http.Get(ts.URL + "/api/update")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status=%d", res.StatusCode)
	}
	var got updatecheck.Snapshot
	if err := json.NewDecoder(res.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got != f.snap {
		t.Errorf("got %+v want %+v", got, f.snap)
	}
}

// TC-UPD-7 / FR-UPD-8: 배지를 읽는 것은 캐시를 채우는 것이 아니다.
func TestUpdateGetNeverTriggers(t *testing.T) {
	f := &fakeUpdates{}
	ts := updateServer(t, f)
	for i := 0; i < 100; i++ {
		res, err := http.Get(ts.URL + "/api/update")
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
	}
	if n := f.triggers.Load(); n != 0 {
		t.Errorf("GET 100회가 확인을 %d회 걸었다", n)
	}
}

// FR-UPD-13: 토글은 여기로 온다. 설정 블롭이 아니다 (D-UPD-2).
func TestUpdatePutSetsToggle(t *testing.T) {
	f := &fakeUpdates{snap: updatecheck.Snapshot{Enabled: true}}
	ts := updateServer(t, f)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/update", strings.NewReader(`{"enabled":false}`))
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(res.Body)
		t.Fatalf("status=%d body=%s", res.StatusCode, b)
	}
	if f.sets.Load() != 1 {
		t.Errorf("SetEnabled 가 %d회 불렸다", f.sets.Load())
	}
	var got updatecheck.Snapshot
	json.NewDecoder(res.Body).Decode(&got)
	if got.Enabled {
		t.Error("응답이 바뀐 상태를 싣지 않았다")
	}
}

func TestUpdatePutRejectsMissingField(t *testing.T) {
	f := &fakeUpdates{}
	ts := updateServer(t, f)
	for _, body := range []string{`{}`, `{bad`, `{"enabled":"yes"}`} {
		req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/update", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode != 400 {
			t.Errorf("%s → status=%d, want 400", body, res.StatusCode)
		}
	}
	if f.sets.Load() != 0 {
		t.Error("잘못된 본문으로 토글이 바뀌었다")
	}
}

// nil 이면 503 이고 그 밖의 동작에는 영향이 없다 — 배지가 없는 서버는 종전의 서버다.
func TestUpdateUnavailableWithoutService(t *testing.T) {
	ts := updateServer(t, nil)
	res, err := http.Get(ts.URL + "/api/update")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 503 {
		t.Errorf("status=%d want 503", res.StatusCode)
	}
	// 종전 표면은 멀쩡하다.
	ping, err := http.Get(ts.URL + "/api/ping")
	if err != nil {
		t.Fatal(err)
	}
	defer ping.Body.Close()
	if ping.StatusCode != 200 {
		t.Errorf("/api/ping status=%d", ping.StatusCode)
	}
}

// TC-UPD-3a / FR-UPD-2 ②: **새로고침과 재연결이 SSE 연결 수립 하나로 온다.**
func TestSSEConnectTriggersCheck(t *testing.T) {
	f := &fakeUpdates{}
	ts := updateServer(t, f)

	for i := 0; i < 3; i++ {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/commands/sse", nil)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		res, err := http.DefaultClient.Do(req.WithContext(ctx))
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		buf := make([]byte, 1)
		res.Body.Read(buf) // 연결이 선 것을 확인한다
		res.Body.Close()
		cancel()
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && f.triggers.Load() < 3 {
		time.Sleep(10 * time.Millisecond)
	}
	if n := f.triggers.Load(); n != 3 {
		t.Errorf("연결 3회에 확인이 %d회 걸렸다", n)
	}
}

// NFR-UPD-2: 연결 수립은 확인을 **기다리지 않는다.**
func TestSSEConnectDoesNotWaitForCheck(t *testing.T) {
	slow := &slowUpdates{started: make(chan struct{}), release: make(chan struct{})}
	ts := updateServer(t, slow)
	defer close(slow.release)

	done := make(chan struct{})
	go func() {
		defer close(done)
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/commands/sse", nil)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		res, err := http.DefaultClient.Do(req.WithContext(ctx))
		if err != nil {
			return
		}
		buf := make([]byte, 1)
		res.Body.Read(buf)
		res.Body.Close()
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("확인이 끝나기를 기다리느라 연결이 서지 못했다")
	}
}

type slowUpdates struct {
	started chan struct{}
	release chan struct{}
	once    atomic.Bool
}

func (s *slowUpdates) Snapshot() updatecheck.Snapshot { return updatecheck.Snapshot{} }
func (s *slowUpdates) Trigger() {
	if s.once.CompareAndSwap(false, true) {
		close(s.started)
	}
	<-s.release
}
func (s *slowUpdates) SetEnabled(bool) error { return nil }
