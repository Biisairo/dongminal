//go:build darwin

package sysstat

import (
	"encoding/binary"
	"errors"
	"testing"
	"time"
)

// 실제 커널을 읽는 스모크 테스트. 값은 환경에 따라 달라지므로 범위·불변식만 본다
// (SYSTEM_STATS_SRS §4 말미).

func TestDarwinReader_MemInRange(t *testing.T) {
	mem, err := NewReader().Mem()
	if errors.Is(err, ErrUnsupported) {
		t.Skip("CGO_ENABLED=0 빌드 — mach 경로 없음")
	}
	if err != nil {
		t.Fatalf("Mem: %v", err)
	}
	if mem.Total == 0 {
		t.Fatal("Total=0 — hw.memsize 파싱 실패")
	}
	// 1GiB 미만이거나 4TiB 초과면 파싱이 어긋난 것이다 (엔디안·절단 회귀 감지).
	if mem.Total < 1<<30 || mem.Total > 4<<40 {
		t.Fatalf("Total=%d 바이트 — 파싱이 어긋났다", mem.Total)
	}
	if mem.Used == 0 {
		t.Fatal("Used=0 — VM 통계 파싱 실패")
	}
	if mem.Used > mem.Total {
		t.Fatalf("Used=%d > Total=%d", mem.Used, mem.Total)
	}
	// 정정 전 계산식은 상시 90%대를 냈다 (§2.5). 회귀하면 여기서 걸린다.
	pct := float64(mem.Used) / float64(mem.Total) * 100
	if pct > 90 {
		t.Errorf("사용률 %.1f%% — free/inactive 역산 계산식으로 회귀했을 수 있다", pct)
	}
	t.Logf("mem used=%.2fGB total=%.2fGB (%.1f%%)",
		float64(mem.Used)/(1<<30), float64(mem.Total)/(1<<30), pct)
}

func TestDarwinReader_CPUTicksMonotonic(t *testing.T) {
	r := NewReader()
	first, err := r.CPUTicks()
	if errors.Is(err, ErrUnsupported) {
		t.Skip("CGO_ENABLED=0 빌드 — mach 경로 없음")
	}
	if err != nil {
		t.Fatalf("CPUTicks: %v", err)
	}
	if first.Total() == 0 {
		t.Fatal("Total()=0 — tick 을 못 읽었다")
	}
	time.Sleep(50 * time.Millisecond)
	second, err := r.CPUTicks()
	if err != nil {
		t.Fatalf("CPUTicks #2: %v", err)
	}
	// 누적 카운터이므로 감소할 수 없다.
	if second.Total() < first.Total() {
		t.Fatalf("누적 tick 이 감소했다: %d → %d", first.Total(), second.Total())
	}
	pct, ok := CPUPercent(first, second)
	if !ok {
		t.Skip("50ms 동안 tick 이 늘지 않았다 — 분해능 문제, 로직 결함 아님")
	}
	if pct < 0 || pct > 100 {
		t.Fatalf("CPU%%=%v 가 0~100 밖이다", pct)
	}
	t.Logf("cpu=%.1f%%", pct)
}

func TestDarwinReader_BootTimeSane(t *testing.T) {
	bt, err := NewReader().BootTime()
	if err != nil {
		t.Fatalf("BootTime: %v", err)
	}
	if bt.After(time.Now()) {
		t.Fatalf("부팅 시각이 미래다: %v", bt)
	}
	// 2015 이전이면 tv_sec 파싱이 어긋난 것이다.
	if bt.Year() < 2015 {
		t.Fatalf("부팅 시각 %v — tv_sec 파싱이 어긋났다", bt)
	}
	t.Logf("boot=%v (uptime %v)", bt, time.Since(bt).Round(time.Minute))
}

func TestDarwinReader_DiskPercentInRange(t *testing.T) {
	pct, err := NewReader().DiskPercent("/")
	if err != nil {
		t.Fatalf("DiskPercent: %v", err)
	}
	if pct < 0 || pct > 100 {
		t.Fatalf("diskPct=%v 가 0~100 밖이다", pct)
	}
}

func TestDarwinReader_DiskPercentBadPath(t *testing.T) {
	if _, err := NewReader().DiskPercent("/definitely/not/a/mount/point"); err == nil {
		t.Fatal("없는 경로인데 오류가 없다")
	}
}

// syscall.Sysctl 이 결과를 Go 문자열로 만들 때 마지막 NUL 을 잘라내므로, 8바이트
// 값이 7바이트로 도착할 수 있다. 그 절단을 견디는지 본다.
func TestParseSysctlUint64(t *testing.T) {
	full := make([]byte, 8)
	binary.LittleEndian.PutUint64(full, 34359738368) // 32GiB
	got, err := parseSysctlUint64(full)
	if err != nil || got != 34359738368 {
		t.Fatalf("8바이트: got=%d err=%v", got, err)
	}

	// 상위 바이트가 0 이라 잘려 도착한 경우.
	small := make([]byte, 8)
	binary.LittleEndian.PutUint64(small, 4096)
	got, err = parseSysctlUint64(small[:2])
	if err != nil || got != 4096 {
		t.Fatalf("절단된 입력: got=%d err=%v", got, err)
	}

	if _, err := parseSysctlUint64(nil); err == nil {
		t.Fatal("빈 입력인데 오류가 없다")
	}
}
