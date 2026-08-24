package sysstat

import (
	"errors"
	"testing"
	"time"
)

// SYSTEM_STATS_SRS 검증. 실제 커널 값에 의존하는 단정은 결정론적이지 않으므로 범위
// 검사로 한정하고(§4 말미), 로직은 fake Reader 로 결정론적으로 검증한다.

// ── CPUPercent (FR-STAT-1) ───────────────────────────

func TestCPUPercent(t *testing.T) {
	cases := []struct {
		name      string
		prev, cur CPUTicks
		want      float64
		wantOK    bool
	}{
		{
			name: "절반 busy",
			prev: CPUTicks{User: 0, System: 0, Idle: 0},
			cur:  CPUTicks{User: 50, System: 0, Idle: 50},
			want: 50, wantOK: true,
		},
		{
			name: "nice 는 busy 에 포함된다",
			prev: CPUTicks{},
			cur:  CPUTicks{User: 10, System: 10, Nice: 20, Idle: 60},
			want: 40, wantOK: true,
		},
		{
			name: "누적값의 차분만 본다 (기준점이 0 이 아니어도)",
			prev: CPUTicks{User: 1000, System: 500, Idle: 8500},
			cur:  CPUTicks{User: 1030, System: 510, Idle: 8560},
			want: 40, wantOK: true,
		},
		{
			name: "전부 idle",
			prev: CPUTicks{},
			cur:  CPUTicks{Idle: 100},
			want: 0, wantOK: true,
		},
		{
			name: "전부 busy",
			prev: CPUTicks{},
			cur:  CPUTicks{User: 100},
			want: 100, wantOK: true,
		},
		{
			name: "소수 1자리 반올림",
			prev: CPUTicks{},
			cur:  CPUTicks{User: 1, Idle: 2},
			want: 33.3, wantOK: true,
		},
		{
			// 같은 시점을 두 번 읽으면 백분율이 정의되지 않는다.
			name:   "tick 증가 없음 → 무효",
			prev:   CPUTicks{User: 10, Idle: 10},
			cur:    CPUTicks{User: 10, Idle: 10},
			wantOK: false,
		},
		{
			// 카운터 리셋/래핑. 음수 차분으로 엉뚱한 값을 내지 않아야 한다.
			name:   "total 감소 → 무효",
			prev:   CPUTicks{User: 100, Idle: 100},
			cur:    CPUTicks{User: 10, Idle: 10},
			wantOK: false,
		},
		{
			name:   "busy 만 감소 → 무효",
			prev:   CPUTicks{User: 100, Idle: 100},
			cur:    CPUTicks{User: 50, Idle: 200},
			wantOK: false,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := CPUPercent(c.prev, c.cur)
			if ok != c.wantOK {
				t.Fatalf("ok=%v want %v (got=%v)", ok, c.wantOK, got)
			}
			if ok && got != c.want {
				t.Fatalf("got=%v want %v", got, c.want)
			}
		})
	}
}

func TestCPUTicksBusyTotal(t *testing.T) {
	tk := CPUTicks{User: 1, System: 2, Idle: 4, Nice: 8}
	if got := tk.Busy(); got != 11 {
		t.Errorf("Busy()=%d want 11 (user+system+nice)", got)
	}
	if got := tk.Total(); got != 15 {
		t.Errorf("Total()=%d want 15", got)
	}
}

// ── fake Reader ──────────────────────────────────────

type fakeReader struct {
	ticks    []CPUTicks
	tickIdx  int
	tickErr  error
	mem      MemInfo
	memErr   error
	boot     time.Time
	bootErr  error
	disk     float64
	diskErr  error
	diskPath string
	calls    int
}

func (f *fakeReader) CPUTicks() (CPUTicks, error) {
	f.calls++
	if f.tickErr != nil {
		return CPUTicks{}, f.tickErr
	}
	if f.tickIdx >= len(f.ticks) {
		if len(f.ticks) == 0 {
			return CPUTicks{}, nil
		}
		return f.ticks[len(f.ticks)-1], nil
	}
	v := f.ticks[f.tickIdx]
	f.tickIdx++
	return v, nil
}

func (f *fakeReader) Mem() (MemInfo, error) { return f.mem, f.memErr }

func (f *fakeReader) BootTime() (time.Time, error) { return f.boot, f.bootErr }

func (f *fakeReader) DiskPercent(path string) (float64, error) {
	f.diskPath = path
	return f.disk, f.diskErr
}

// ── Sampler (FR-STAT-8·9·11·12, FR-STAT-7) ───────────

// FR-STAT-12: 기동 즉시 CPU 외 지표는 유효하고, CPU 는 차분이 성립하는 두 번째
// 샘플부터 유효하다.
func TestSampler_CPUNeedsTwoSamples(t *testing.T) {
	r := &fakeReader{
		ticks: []CPUTicks{{User: 0, Idle: 0}, {User: 30, Idle: 70}},
		mem:   MemInfo{Total: 100, Used: 20},
		boot:  time.Unix(1000, 0),
		disk:  42.0,
	}
	s := NewSampler(r, time.Hour, "/")

	s.sample()
	snap := s.Snapshot()
	if snap.CPUValid {
		t.Error("첫 샘플에 CPU 가 유효하다 — tick 차분 없이는 산출 불가")
	}
	if !snap.MemValid || !snap.BootValid || !snap.DiskValid {
		t.Errorf("첫 샘플에 CPU 외 지표가 무효다: %+v", snap)
	}

	s.sample()
	snap = s.Snapshot()
	if !snap.CPUValid {
		t.Fatal("두 번째 샘플에도 CPU 가 무효다")
	}
	if snap.CPU != 30 {
		t.Fatalf("CPU=%v want 30", snap.CPU)
	}
}

// FR-STAT-7: 한 지표의 실패가 나머지를 막지 않는다.
func TestSampler_PartialFailureIsolated(t *testing.T) {
	r := &fakeReader{
		memErr: errors.New("boom"),
		boot:   time.Unix(2000, 0),
		disk:   10.0,
		ticks:  []CPUTicks{{Idle: 1}, {Idle: 2}},
	}
	s := NewSampler(r, time.Hour, "/")
	s.sample()
	s.sample()

	snap := s.Snapshot()
	if snap.MemValid {
		t.Error("실패한 메모리 지표가 유효로 표시됐다")
	}
	if !snap.BootValid || !snap.DiskValid || !snap.CPUValid {
		t.Errorf("메모리 실패가 다른 지표를 오염시켰다: %+v", snap)
	}
}

// FR-STAT-7: 실패는 마지막 유효값을 지우지 않는다.
func TestSampler_KeepsLastValidOnFailure(t *testing.T) {
	r := &fakeReader{
		mem:   MemInfo{Total: 100, Used: 40},
		ticks: []CPUTicks{{Idle: 1}},
	}
	s := NewSampler(r, time.Hour, "/")
	s.sample()
	if got := s.Snapshot().Mem.Used; got != 40 {
		t.Fatalf("Used=%d want 40", got)
	}

	r.memErr = errors.New("transient")
	r.mem = MemInfo{}
	s.sample()

	snap := s.Snapshot()
	if !snap.MemValid {
		t.Error("일시적 실패가 유효 플래그를 내렸다")
	}
	if snap.Mem.Used != 40 {
		t.Errorf("Used=%d want 40 (마지막 유효값 유지)", snap.Mem.Used)
	}
}

// ErrUnsupported 는 치명적 오류가 아니어야 한다 — CGO_ENABLED=0 darwin 에서
// CPU·메모리만 빠지고 나머지는 계속 갱신되는 경로다.
func TestSampler_UnsupportedIsNotFatal(t *testing.T) {
	r := &fakeReader{
		tickErr: ErrUnsupported,
		memErr:  ErrUnsupported,
		boot:    time.Unix(3000, 0),
		disk:    55.5,
	}
	s := NewSampler(r, time.Hour, "/")
	s.sample()
	s.sample()

	snap := s.Snapshot()
	if snap.CPUValid || snap.MemValid {
		t.Errorf("지원되지 않는 지표가 유효로 표시됐다: %+v", snap)
	}
	if !snap.BootValid || !snap.DiskValid {
		t.Errorf("지원되는 지표가 함께 죽었다: %+v", snap)
	}
	if snap.DiskPct != 55.5 {
		t.Errorf("DiskPct=%v want 55.5", snap.DiskPct)
	}
}

// FR-STAT-11: 커널 호출은 주기당 1회다 — Snapshot 을 몇 번 읽든 늘지 않는다.
func TestSampler_SnapshotDoesNotReadKernel(t *testing.T) {
	r := &fakeReader{ticks: []CPUTicks{{Idle: 1}, {Idle: 2}}}
	s := NewSampler(r, time.Hour, "/")
	s.sample()
	before := r.calls
	for i := 0; i < 100; i++ {
		s.Snapshot()
	}
	if r.calls != before {
		t.Fatalf("Snapshot 이 커널을 %d 회 더 호출했다", r.calls-before)
	}
}

// FR-STAT-13: stopCh 가 닫히면 goroutine 이 끝난다.
func TestSampler_StopsOnChannelClose(t *testing.T) {
	r := &fakeReader{ticks: []CPUTicks{{Idle: 1}}}
	s := NewSampler(r, 5*time.Millisecond, "/")
	stop := make(chan struct{})
	s.Start(stop)

	// 몇 주기 돌게 둔다.
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		if s.Snapshot().CPUValid {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	close(stop)

	time.Sleep(30 * time.Millisecond)
	after := r.calls
	time.Sleep(60 * time.Millisecond)
	if r.calls != after {
		t.Fatalf("stopCh 닫힘 후에도 샘플링이 계속됐다 (%d → %d)", after, r.calls)
	}
}

func TestSampler_Defaults(t *testing.T) {
	r := &fakeReader{}
	s := NewSampler(r, 0, "")
	if s.interval != DefaultInterval {
		t.Errorf("interval=%v want %v", s.interval, DefaultInterval)
	}
	s.sample()
	if r.diskPath != "/" {
		t.Errorf("diskPath=%q want \"/\"", r.diskPath)
	}
}

// 디스크 사용률은 소수 1자리로 반올림해 보관한다 (기존 표시 규약 유지).
func TestSampler_DiskRounding(t *testing.T) {
	r := &fakeReader{disk: 42.06}
	s := NewSampler(r, time.Hour, "/")
	s.sample()
	if got := s.Snapshot().DiskPct; got != 42.1 {
		t.Fatalf("DiskPct=%v want 42.1 (소수 1자리)", got)
	}
}
