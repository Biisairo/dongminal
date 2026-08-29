package sysstat

import (
	"testing"
	"time"
)

// 실제 /proc/stat 의 앞부분이다. 열 순서를 틀리면 CPU% 가 조용히 엉뚱해진다.
const procStatFixture = `cpu  120000 500 30000 900000 2000 100 200 0 0 0
cpu0 60000 250 15000 450000 1000 50 100 0 0 0
intr 12345
ctxt 987654
btime 1756400000
processes 4242
`

func TestParseProcStatCPU(t *testing.T) {
	got, err := parseProcStatCPU(procStatFixture)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	// iowait(2000) 는 idle 에 더한다 — 그 시간에 CPU 는 일하고 있지 않다.
	want := CPUTicks{User: 120000, Nice: 500, System: 30000, Idle: 902000}
	if got != want {
		t.Fatalf("parseProcStatCPU = %+v, want %+v", got, want)
	}
	if got.Busy() != 150500 {
		t.Fatalf("Busy = %d", got.Busy())
	}
}

func TestParseProcStatCPUErrors(t *testing.T) {
	if _, err := parseProcStatCPU("intr 1\nbtime 2\n"); err == nil {
		t.Fatal("cpu 줄이 없는데 성공했다")
	}
	if _, err := parseProcStatCPU("cpu  a b c d\n"); err == nil {
		t.Fatal("숫자가 아닌 값에 성공했다")
	}
}

func TestParseProcStatBootTime(t *testing.T) {
	got, err := parseProcStatBootTime(procStatFixture)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if !got.Equal(time.Unix(1756400000, 0)) {
		t.Fatalf("btime = %v", got)
	}
	if _, err := parseProcStatBootTime("cpu 1 2 3 4\n"); err == nil {
		t.Fatal("btime 이 없는데 성공했다")
	}
}

// MemAvailable 이 있으면 그것을 쓴다. MemFree 로 계산하면 캐시가 전부
// "사용 중" 으로 잡혀 크게 과대평가된다 (SYSTEM_STATS_SRS D-2 와 같은 함정).
func TestParseProcMeminfoPrefersMemAvailable(t *testing.T) {
	const fixture = `MemTotal:       16000000 kB
MemFree:          500000 kB
MemAvailable:   10000000 kB
Buffers:          200000 kB
Cached:          6000000 kB
`
	got, err := parseProcMeminfo(fixture)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	const kB = 1024
	if got.Total != 16000000*kB {
		t.Fatalf("Total = %d", got.Total)
	}
	if got.Used != 6000000*kB {
		t.Fatalf("Used = %d, want %d — MemFree 로 계산했을 수 있다", got.Used, 6000000*kB)
	}
}

// MemAvailable 이 없는 낡은 커널에서는 free+buffers+cached 로 근사한다.
func TestParseProcMeminfoFallback(t *testing.T) {
	const fixture = `MemTotal:       16000000 kB
MemFree:          500000 kB
Buffers:          200000 kB
Cached:          6000000 kB
`
	got, err := parseProcMeminfo(fixture)
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	const kB = 1024
	if got.Used != (16000000-6700000)*kB {
		t.Fatalf("Used = %d", got.Used)
	}
}

func TestParseProcMeminfoErrors(t *testing.T) {
	if _, err := parseProcMeminfo("MemFree: 100 kB\n"); err == nil {
		t.Fatal("MemTotal 이 없는데 성공했다")
	}
}

// available 이 total 을 넘으면 사용량이 음수가 된다. uint 라 그대로 두면
// 천문학적 값으로 감긴다.
func TestParseProcMeminfoClampsAvailable(t *testing.T) {
	got, err := parseProcMeminfo("MemTotal: 1000 kB\nMemAvailable: 9999 kB\n")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got.Used != 0 {
		t.Fatalf("Used = %d, want 0", got.Used)
	}
}
