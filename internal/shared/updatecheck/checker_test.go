package updatecheck

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/serverconf"
)

// probe 는 릴리스 자리를 흉내내며 **몇 번 물었는지** 센다. 이 숫자가
// UPDATE_NOTICE_SRS 의 네트워크 예산(§3.4) 검사 전부다.
type probe struct {
	hits atomic.Int64
	srv  *httptest.Server
	tag  atomic.Value // string
	fail atomic.Bool
}

func newProbe(t *testing.T, tag string) *probe {
	t.Helper()
	p := &probe{}
	p.tag.Store(tag)
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p.hits.Add(1)
		if p.fail.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		cur, _ := p.tag.Load().(string)
		w.Write([]byte(`{"tag_name":"` + cur + `","html_url":"https://example/rel/` + cur + `"}`))
	}))
	t.Cleanup(p.srv.Close)
	return p
}

func (p *probe) count() int64 { return p.hits.Load() }

// newChecker 는 검사용 확인기다. **실제 GitHub 으로 나가지 않는다** (TC-UPD-14).
func newChecker(t *testing.T, p *probe, opt Options) (*Checker, chan struct{}) {
	t.Helper()
	if opt.Home == "" {
		opt.Home = t.TempDir()
	}
	if opt.Current == "" {
		opt.Current = "v1.0.0"
	}
	if opt.Interval == 0 {
		opt.Interval = time.Hour
	}
	if opt.Getenv == nil {
		opt.Getenv = func(string) string { return "" }
	}
	opt.Endpoint = p.srv.URL
	c := New(opt)
	settled := make(chan struct{}, 64)
	c.onSettle = func() { settled <- struct{}{} }
	t.Cleanup(c.Stop)
	return c, settled
}

func waitSettle(t *testing.T, ch chan struct{}) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal("확인이 끝나지 않았다")
	}
}

func quiet(t *testing.T, ch chan struct{}) {
	t.Helper()
	select {
	case <-ch:
		t.Fatal("돌지 않아야 할 확인이 돌았다")
	case <-time.After(150 * time.Millisecond):
	}
}

// ── §1.2 불변 조항: 끈 것은 실제로 나가지 않아야 한다 ──────────────

// TC-UPD-1
func TestDisabledNeverLeaves(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	c, ch := newChecker(t, p, Options{Enabled: false})
	c.Start()
	c.Trigger()
	quiet(t, ch)
	if n := p.count(); n != 0 {
		t.Errorf("꺼져 있는데 %d회 나갔다", n)
	}
}

// TC-UPD-2: 환경변수는 다른 모든 계층을 이긴다 (FR-UPD-11).
func TestEnvKillSwitchWins(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	c, ch := newChecker(t, p, Options{
		Enabled: true,
		Getenv:  func(k string) string { return map[string]string{EnvNoCheck: "1"}[k] },
	})
	c.Start()
	c.Trigger()
	quiet(t, ch)
	if n := p.count(); n != 0 {
		t.Errorf("킬스위치를 켰는데 %d회 나갔다", n)
	}
	if c.Snapshot().Enabled {
		t.Error("막혀 있는데 켜졌다고 답한다")
	}
}

// TC-UPD-15
func TestDisabledSurvivesAllTriggers(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	c, ch := newChecker(t, p, Options{Enabled: false, Interval: 20 * time.Millisecond})
	c.Start()
	for i := 0; i < 50; i++ {
		c.Trigger()
	}
	quiet(t, ch)
	if n := p.count(); n != 0 {
		t.Errorf("트리거 50회에 %d회 나갔다", n)
	}
}

// ── 트리거 넷 (FR-UPD-2) ───────────────────────────────────────

// TC-UPD-3: 트리거 ① 서버 기동
func TestStartChecksOnce(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	c, ch := newChecker(t, p, Options{Enabled: true})
	c.Start()
	waitSettle(t, ch)
	if n := p.count(); n != 1 {
		t.Errorf("기동에 %d회 나갔다", n)
	}
}

// TC-UPD-3a: 트리거 ② SSE 연결
func TestTriggerChecks(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	c, ch := newChecker(t, p, Options{Enabled: true})
	c.Trigger()
	waitSettle(t, ch)
	if n := p.count(); n != 1 {
		t.Errorf("%d회 나갔다", n)
	}
}

// TC-UPD-3b: 창 열 개를 한꺼번에 새로고침해도 요청은 1건이다 (FR-UPD-2b).
func TestConcurrentTriggersCollapse(t *testing.T) {
	block := make(chan struct{})
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		<-block
		w.Write([]byte(`{"tag_name":"v9.9.9"}`))
	}))
	defer srv.Close()

	c := New(Options{
		Home: t.TempDir(), Current: "v1.0.0", Enabled: true,
		Endpoint: srv.URL, Interval: time.Hour,
		Getenv: func(string) string { return "" },
	})
	defer c.Stop()
	settled := make(chan struct{}, 64)
	c.onSettle = func() { settled <- struct{}{} }

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); c.Trigger() }()
	}
	wg.Wait()
	// 열이 전부 들어온 뒤에 응답을 푼다 — 그래야 합류가 검사된다.
	time.Sleep(100 * time.Millisecond)
	close(block)
	waitSettle(t, settled)
	if n := hits.Load(); n != 1 {
		t.Errorf("동시 트리거 10회에 %d건 나갔다 (single-flight 아님)", n)
	}
}

// TC-UPD-3c: 순차 트리거는 트리거마다 갱신한다 — 이 설계는 가드를 두지 않는다.
func TestSequentialTriggersEachCheck(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	c, ch := newChecker(t, p, Options{Enabled: true})
	for i := 0; i < 3; i++ {
		c.Trigger()
		waitSettle(t, ch)
	}
	if n := p.count(); n != 3 {
		t.Errorf("순차 3회에 %d건 나갔다", n)
	}
}

// TC-UPD-3g: 타이머는 확인이 끝날 때마다 다시 걸린다 (FR-UPD-2c).
// TC-UPD-3h: 트리거 없이 띄워 둔 서버도 갱신된다.
func TestTimerRearms(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	c, ch := newChecker(t, p, Options{Enabled: true, Interval: 40 * time.Millisecond})
	c.Start()
	for i := 0; i < 3; i++ {
		waitSettle(t, ch)
	}
	if n := p.count(); n < 3 {
		t.Errorf("타이머가 다시 걸리지 않았다: %d건", n)
	}
}

// ── 판정 (FR-UPD-9b, TC-UPD-5·6) ──────────────────────────────

func TestNewerVersionIsReported(t *testing.T) {
	p := newProbe(t, "v1.10.0")
	c, ch := newChecker(t, p, Options{Enabled: true, Current: "v1.9.0"})
	c.Trigger()
	waitSettle(t, ch)
	s := c.Snapshot()
	if !s.Newer {
		t.Errorf("v1.10.0 > v1.9.0 을 놓쳤다: %+v", s)
	}
	if s.Latest != "v1.10.0" || s.Link == "" {
		t.Errorf("%+v", s)
	}
}

func TestSameVersionIsNotNewer(t *testing.T) {
	p := newProbe(t, "v1.0.0")
	c, ch := newChecker(t, p, Options{Enabled: true, Current: "v1.0.0"})
	c.Trigger()
	waitSettle(t, ch)
	if c.Snapshot().Newer {
		t.Error("같은 판을 새 판이라 했다")
	}
}

// TC-UPD-6: 개발 빌드는 견줄 기준이 없다.
func TestDevBuildNeverNewer(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	c, ch := newChecker(t, p, Options{Enabled: true, Current: "dev"})
	c.Trigger()
	waitSettle(t, ch)
	if c.Snapshot().Newer {
		t.Error("dev 를 뒤졌다고 했다")
	}
}

// ── 실패 (FR-UPD-2e, TC-UPD-3d·3e·3f) ─────────────────────────

func TestFailureKeepsPreviousResult(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	c, ch := newChecker(t, p, Options{Enabled: true, Current: "v1.0.0"})
	c.Trigger()
	waitSettle(t, ch)
	before := c.Snapshot()

	p.fail.Store(true)
	c.Trigger()
	waitSettle(t, ch)
	after := c.Snapshot()

	if after.Latest != before.Latest || after.Newer != before.Newer {
		t.Errorf("실패가 직전 결과를 덮었다: %+v → %+v", before, after)
	}
	if !after.Failed {
		t.Error("실패를 말하지 않았다")
	}
}

func TestFailureWithoutPriorIsUnknown(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	p.fail.Store(true)
	c, ch := newChecker(t, p, Options{Enabled: true})
	c.Trigger()
	waitSettle(t, ch)
	s := c.Snapshot()
	if s.Newer || s.Latest != "" {
		t.Errorf("모르는 것을 안다고 했다: %+v", s)
	}
	if !s.Failed {
		t.Error("실패를 말하지 않았다")
	}
}

// TC-UPD-3f: 백오프가 없다 — 다음 트리거에 그냥 다시 시도한다.
func TestFailureRetriesOnNextTrigger(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	p.fail.Store(true)
	c, ch := newChecker(t, p, Options{Enabled: true})
	c.Trigger()
	waitSettle(t, ch)
	p.fail.Store(false)
	c.Trigger()
	waitSettle(t, ch)
	if !c.Snapshot().Newer {
		t.Error("실패 뒤 재시도가 성공을 반영하지 않았다")
	}
	if n := p.count(); n != 2 {
		t.Errorf("%d건", n)
	}
}

// ── 방송 (FR-UPD-8a·8b, TC-UPD-7a·7b) ──────────────────────────

func TestBroadcastsOnlyOnChange(t *testing.T) {
	p := newProbe(t, "v1.0.0")
	var casts atomic.Int64
	c, ch := newChecker(t, p, Options{
		Enabled: true, Current: "v1.0.0",
		Broadcast: func() { casts.Add(1) },
	})
	c.Trigger()
	waitSettle(t, ch)
	first := casts.Load()
	if first != 1 {
		t.Errorf("첫 결과를 알리지 않았다: %d", first)
	}
	c.Trigger()
	waitSettle(t, ch)
	if got := casts.Load(); got != first {
		t.Errorf("바뀌지 않았는데 %d회 방송했다", got-first)
	}
	p.tag.Store("v2.0.0")
	c.Trigger()
	waitSettle(t, ch)
	if got := casts.Load(); got != first+1 {
		t.Errorf("바뀌었는데 알리지 않았다: %d", got)
	}
}

// ── 토글 (FR-UPD-13·14, TC-UPD-8·9·9a) ────────────────────────

func TestSetEnabledPersistsAndStops(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	home := t.TempDir()
	c, ch := newChecker(t, p, Options{Enabled: true, Home: home, Interval: 30 * time.Millisecond})
	c.Start()
	waitSettle(t, ch)

	if err := c.SetEnabled(false); err != nil {
		t.Fatal(err)
	}
	quiet(t, ch)

	data, err := os.ReadFile(filepath.Join(home, serverconf.FileName))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"updateCheck": false`) {
		t.Errorf("server.json 에 남지 않았다: %s", data)
	}
	if c.Snapshot().Enabled {
		t.Error("껐는데 켜졌다고 답한다")
	}
}

// TC-UPD-9: 끔→켬 은 트리거 ④ 다.
func TestSetEnabledTrueChecks(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	c, ch := newChecker(t, p, Options{Enabled: false})
	if err := c.SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	waitSettle(t, ch)
	if n := p.count(); n != 1 {
		t.Errorf("켜는데 %d건 나갔다", n)
	}
}

// 이미 켜진 것을 또 켜는 것은 트리거가 아니다 — 끔→켬 만이 계기다.
func TestSetEnabledTrueWhenAlreadyOnDoesNotCheck(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	c, ch := newChecker(t, p, Options{Enabled: true})
	if err := c.SetEnabled(true); err != nil {
		t.Fatal(err)
	}
	quiet(t, ch)
	if n := p.count(); n != 0 {
		t.Errorf("%d건", n)
	}
}

// TC-UPD-9a: 확인이 도는 중에 끄면 그 결과를 쓰지 않는다 (§1.2).
func TestDisableDuringFlightDiscardsResult(t *testing.T) {
	block := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-block
		w.Write([]byte(`{"tag_name":"v9.9.9","html_url":"https://example/rel"}`))
	}))
	defer srv.Close()

	c := New(Options{
		Home: t.TempDir(), Current: "v1.0.0", Enabled: true,
		Endpoint: srv.URL, Interval: time.Hour,
		Getenv: func(string) string { return "" },
	})
	defer c.Stop()
	settled := make(chan struct{}, 4)
	c.onSettle = func() { settled <- struct{}{} }

	c.Trigger()
	time.Sleep(80 * time.Millisecond)
	if err := c.SetEnabled(false); err != nil {
		t.Fatal(err)
	}
	close(block)
	waitSettle(t, settled)
	if s := c.Snapshot(); s.Newer || s.Latest != "" {
		t.Errorf("끈 뒤에도 결과를 썼다: %+v", s)
	}
}

// Snapshot 은 네트워크를 만지지 않는다 (NFR-UPD-3, TC-UPD-7).
func TestSnapshotNeverFetches(t *testing.T) {
	p := newProbe(t, "v9.9.9")
	c, _ := newChecker(t, p, Options{Enabled: true})
	for i := 0; i < 100; i++ {
		_ = c.Snapshot()
	}
	if n := p.count(); n != 0 {
		t.Errorf("Snapshot 이 %d회 나갔다", n)
	}
}
