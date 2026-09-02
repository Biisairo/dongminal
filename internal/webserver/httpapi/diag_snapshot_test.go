package httpapi

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// CONNECTIVITY_RESILIENCE_SRS 묶음 B — 끊긴 순간의 기록 (V-CNR-7~10).
//
// **왜 필요한가.** 로그에 남는 것은 온 요청뿐이라(`server.go:196`), 요청이 오지
// 않은 구간과 서버가 죽은 구간과 로그가 비어 있는 구간이 **기록상 구별되지
// 않는다** (§2.3). 그래서 "한번씩 안 된다" 는 그 순간들에 대해 지금 우리가 아는
// 것이 없다.
//
// 스냅샷의 설계 목표는 §2.4 의 두 증상을 **가르는 것**이다 — 로딩 중 멈춤(서버
// 쪽)과 연결 거부(경로 쪽). `reqAge` 의 공백이 그 판별자다.

// captureLog 는 log 출력을 가로챈다. 스냅샷은 로그로만 나가므로(D-4) 그것을
// 읽는 것이 유일한 검사 수단이다.
// logBuf 는 잠금이 있는 로그 수집 버퍼다.
//
// 잠금이 필요한 이유는 로그를 쓰는 주체가 테스트 고루틴만이 아니기 때문이다 —
// 스냅샷 루프는 자기 고루틴에서 `log.Printf` 를 부른다. 잠금 없는 bytes.Buffer
// 를 쓰면 그것을 읽는 순간이 곧 경쟁이고, 실제로 `-race` 가 그것을 잡았다
// (V-CAF-1). 검사 수단이 검사 대상을 흔들면 안 된다.
type logBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *logBuf) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *logBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func captureLog(t *testing.T) *logBuf {
	t.Helper()
	buf := &logBuf{}
	old := log.Writer()
	flags := log.Flags()
	log.SetOutput(buf)
	log.SetFlags(0)
	t.Cleanup(func() { log.SetOutput(old); log.SetFlags(flags) })
	return buf
}

// V-CNR-7 (FR-CNR-8): 한 줄에 §3.2 의 항목이 모두 있다. 하나라도 빠지면 다음에
// 끊겼을 때 그만큼을 못 가른다.
func TestDiagSnapshotHasAllFields(t *testing.T) {
	buf := captureLog(t)
	s := &Server{}
	s.logDiagSnapshot()

	line := buf.String()
	for _, key := range []string{
		"diag", "reqAge=", "wsAge=", "ws=", "tools=", "miss=", "hold=",
		"goroutines=", "allocMB=",
	} {
		if !strings.Contains(line, key) {
			t.Fatalf("스냅샷에 %q 가 없다:\n%s", key, line)
		}
	}
}

// V-CNR-8 (FR-CNR-9): 값이 그대로여도 계속 남긴다. 변할 때만 남기면 **조용한
// 구간이 로그에서 사라지고, 그 조용함이 곧 우리가 찾는 증거다.**
func TestDiagSnapshotRepeatsWhenUnchanged(t *testing.T) {
	buf := captureLog(t)
	s := &Server{}
	s.logDiagSnapshot()
	s.logDiagSnapshot()
	s.logDiagSnapshot()

	if n := strings.Count(buf.String(), "diag "); n != 3 {
		t.Fatalf("스냅샷이 %d줄 — 값이 같다고 건너뛰었다 (want 3)\n%s", n, buf.String())
	}
}

// V-CNR-9 (FR-CNR-11): **로그에서 빠지는 요청도** reqAge 를 갱신한다.
// `/api/ping` 은 `shouldLogRequest` 가 거르지만, 로그에 안 남는 것과 오지 않은
// 것은 다르며 그 차이가 이 기능의 전부다.
func TestDiagLastRequestUpdatedByFilteredPath(t *testing.T) {
	s := &Server{}
	h := loggingMiddlewareFor(s, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))

	if s.lastReq.Load() != 0 {
		t.Fatal("아직 요청이 없는데 lastReq 가 서 있다")
	}
	// 로그에서 걸러지는 경로다.
	if shouldLogRequest("/api/ping", 200) {
		t.Fatal("전제가 깨졌다 — /api/ping 이 로그에 남는다")
	}
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/ping", nil))

	if s.lastReq.Load() == 0 {
		t.Fatal("걸러지는 경로가 lastReq 를 갱신하지 않았다 — FR-CNR-11 위반")
	}
}

// FR-CNR-8: 요청이 온 적 없으면 reqAge 는 "-" 다. 0초로 적으면 **방금 왔다**로
// 읽혀, 서버가 막 떴을 때와 오래 조용한 때가 구별되지 않는다.
func TestDiagSnapshotNeverRequestedShowsDash(t *testing.T) {
	buf := captureLog(t)
	s := &Server{}
	s.logDiagSnapshot()
	if !strings.Contains(buf.String(), "reqAge=-") {
		t.Fatalf("요청이 없었는데 reqAge 가 수치다:\n%s", buf.String())
	}
}

// FR-CNR-8: 붙잡고 있는 수가 스냅샷에 실린다 — 묶음 A 의 지표가 §2.1 의 값들과
// 함께 읽혀야 한다.
func TestDiagSnapshotReportsHolds(t *testing.T) {
	buf := captureLog(t)
	s := &Server{}
	s.holds.Store(7)
	s.logDiagSnapshot()
	if !strings.Contains(buf.String(), "hold=7") {
		t.Fatalf("hold 수가 실리지 않았다:\n%s", buf.String())
	}
}

// V-CNR-10 (FR-CNR-12): 컨텍스트가 끝나면 고루틴도 끝난다. 서버 수명을 넘겨
// 살아남는 고루틴을 만들지 않는다.
func TestDiagSnapshotLoopStopsWithContext(t *testing.T) {
	captureLog(t)
	s := &Server{}
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() { s.runDiagSnapshots(ctx, 10*time.Millisecond); close(done) }()

	time.Sleep(30 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("컨텍스트가 끝났는데 스냅샷 고루틴이 살아 있다 — FR-CNR-12 위반")
	}
}

// FR-CNR-9·12: 주기마다 실제로 남는다.
func TestDiagSnapshotLoopWritesPeriodically(t *testing.T) {
	buf := captureLog(t)
	s := &Server{}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan struct{})
	go func() { s.runDiagSnapshots(ctx, 10*time.Millisecond); close(done) }()
	time.Sleep(120 * time.Millisecond)
	cancel()
	// **끝난 것을 확인한 뒤에 읽는다.** cancel 은 종료를 요청할 뿐 기다리지
	// 않는다 — 바로 위 …StopsWithContext 가 지키는 규약이 이것이며, 그 규약이
	// 여기에만 빠져 있었다 (FR-CAF-1). 고루틴이 실제로 끝난다는 사실은 그
	// 테스트가 이미 보증하므로 여기서는 다시 재지 않는다.
	<-done

	if n := strings.Count(buf.String(), "diag "); n < 2 {
		t.Fatalf("스냅샷이 %d줄뿐이다 — 주기적으로 남지 않는다\n%s", n, buf.String())
	}
}
