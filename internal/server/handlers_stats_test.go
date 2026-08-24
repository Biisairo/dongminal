package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"dongminal/internal/sysstat"
)

// SYSTEM_STATS_SRS 묶음 A~C 의 서버측 검증.

type fakeStats struct {
	snap  sysstat.Snapshot
	calls int
}

func (f *fakeStats) Snapshot() sysstat.Snapshot {
	f.calls++
	return f.snap
}

func statsServer(t *testing.T, snap sysstat.Snapshot) (*httptest.Server, *fakeStats) {
	t.Helper()
	fs := &fakeStats{snap: snap}
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Stats: fs})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, fs
}

func fetchStats(t *testing.T, ts *httptest.Server) map[string]any {
	t.Helper()
	resp, err := http.Get(ts.URL + "/api/stats")
	if err != nil {
		t.Fatalf("GET /api/stats: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return body
}

func TestStats_AllValid(t *testing.T) {
	boot := time.Now().Add(-3 * time.Hour)
	ts, _ := statsServer(t, sysstat.Snapshot{
		CPU: 27.7, CPUValid: true,
		Mem: sysstat.MemInfo{Total: 34359738368, Used: 6624083968}, MemValid: true,
		DiskPct: 42.1, DiskValid: true,
		BootTime: boot, BootValid: true,
	})
	body := fetchStats(t, ts)

	for _, k := range []string{"hostname", "srvUptime", "cpu", "memUsed", "memTotal", "diskPct", "sysUptime"} {
		if _, ok := body[k]; !ok {
			t.Errorf("키 %q 누락", k)
		}
	}
	if body["cpu"] != 27.7 {
		t.Errorf("cpu=%v want 27.7", body["cpu"])
	}
	if got := body["memUsed"].(float64); uint64(got) != 6624083968 {
		t.Errorf("memUsed=%v want 6624083968", got)
	}
	if s, _ := body["sysUptime"].(string); !strings.Contains(s, "h") {
		t.Errorf("sysUptime=%q — 3시간 전 부팅이면 시간 단위가 있어야 한다", s)
	}
}

// FR-STAT-7: 한 번도 유효하지 않았던 지표는 키가 생략된다. 클라이언트
// _updateStatusBar 가 truthy / !==undefined 로 검사하므로 0 을 넣는 것보다 안전하다.
func TestStats_OmitsInvalidKeys(t *testing.T) {
	ts, _ := statsServer(t, sysstat.Snapshot{
		DiskPct: 10, DiskValid: true,
	})
	body := fetchStats(t, ts)

	for _, k := range []string{"cpu", "memUsed", "memTotal", "sysUptime"} {
		if _, ok := body[k]; ok {
			t.Errorf("무효 지표 %q 가 응답에 있다: %v", k, body[k])
		}
	}
	// 항상 있는 것들은 남아야 한다.
	for _, k := range []string{"hostname", "srvUptime", "diskPct"} {
		if _, ok := body[k]; !ok {
			t.Errorf("키 %q 누락", k)
		}
	}
}

// FR-STAT-12: 기동 직후(CPU 차분 미성립)에도 500 이 아니고 나머지 지표를 준다.
func TestStats_ColdStartHasNoCPU(t *testing.T) {
	ts, _ := statsServer(t, sysstat.Snapshot{
		Mem: sysstat.MemInfo{Total: 100, Used: 20}, MemValid: true,
	})
	body := fetchStats(t, ts)
	if _, ok := body["cpu"]; ok {
		t.Error("차분 미성립인데 cpu 키가 있다")
	}
	if _, ok := body["memTotal"]; !ok {
		t.Error("memTotal 이 없다 — CPU 무효가 다른 지표를 막았다")
	}
}

// Stats 미주입 wiring 도 500 이 아니어야 한다.
func TestStats_NilProviderStillResponds(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	body := fetchStats(t, ts)
	if _, ok := body["hostname"]; !ok {
		t.Error("hostname 이 없다")
	}
	if _, ok := body["cpu"]; ok {
		t.Error("Stats 미주입인데 cpu 키가 있다")
	}
}

// FR-STAT-9/10/11: 핸들러는 스냅샷을 요청당 1회 읽을 뿐이고, 커널 호출은 없다.
func TestStats_ReadsSnapshotOncePerRequest(t *testing.T) {
	ts, fs := statsServer(t, sysstat.Snapshot{DiskPct: 1, DiskValid: true})
	for i := 0; i < 5; i++ {
		fetchStats(t, ts)
	}
	if fs.calls != 5 {
		t.Fatalf("Snapshot 호출=%d want 5 (요청당 1회)", fs.calls)
	}
}

// FR-STAT-10: 응답이 즉시 나와야 한다. 교체 전에는 `top` 때문에 1.4~1.8초였다.
func TestStats_RespondsFast(t *testing.T) {
	ts, _ := statsServer(t, sysstat.Snapshot{
		CPU: 5, CPUValid: true,
		Mem: sysstat.MemInfo{Total: 100, Used: 10}, MemValid: true,
	})
	for i := 0; i < 5; i++ {
		start := time.Now()
		fetchStats(t, ts)
		if elapsed := time.Since(start); elapsed > 10*time.Millisecond {
			t.Fatalf("응답 %v — FR-STAT-10 은 10ms 이하를 요구한다", elapsed)
		}
	}
}

// FR-STAT-6: getStats 경로에 외부 프로세스 실행이 남아 있지 않은지 소스에서 확인한다.
// 런타임 단정으로는 "fork 하지 않음"을 직접 관측할 수 없다.
func TestStats_NoExecInSource(t *testing.T) {
	out, err := exec.Command("grep", "-n", "exec.Command", "handlers_api.go").CombinedOutput()
	if err == nil && len(out) > 0 {
		t.Fatalf("handlers_api.go 에 exec.Command 가 남아 있다:\n%s", out)
	}
}
