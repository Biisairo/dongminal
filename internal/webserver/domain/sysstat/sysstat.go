// Package sysstat 는 상태바 지표(CPU·메모리·디스크·부팅시각)를 커널에서 직접 읽는다.
//
// 이 패키지가 따로 있는 이유는 cgo 격리다 (SYSTEM_STATS_SRS D-5). macOS 의 CPU tick 과
// VM 통계는 mach 호출(`host_statistics`)로만 얻을 수 있어 cgo 가 필요한데, 그 의존을
// 여기 한 패키지에 묶어 두면 나머지 패키지의 빌드·테스트가 cgo 에 묶이지 않는다.
//
// 이 파일과 sampler.go 는 빌드 태그가 없는 순수 Go 다 — 모든 플랫폼에서 컴파일되고
// 테스트된다. 플랫폼 의존 코드는 reader_*.go / mach_*.go 에 있다.
package sysstat

import (
	"errors"
	"math"
	"time"
)

// ErrUnsupported 는 이 빌드에서 해당 지표를 읽을 수 없다는 뜻이다 (cgo 없이 빌드된
// darwin, 또는 darwin 이 아닌 플랫폼). 호출자는 이를 치명적 오류로 다루지 않고 해당
// 지표만 비운다 (FR-STAT-7).
var ErrUnsupported = errors.New("sysstat: 이 빌드/플랫폼에서 지원되지 않는 지표")

// CPUTicks 는 커널이 보고하는 **누적** CPU tick 이다. 단일 시점의 값에는 순간 사용률
// 정보가 없다 — 두 시점의 차분으로만 백분율이 나온다 (FR-STAT-1).
type CPUTicks struct {
	User   uint64
	System uint64
	Idle   uint64
	Nice   uint64
}

// Busy 는 idle 을 제외한 tick 합이다.
func (t CPUTicks) Busy() uint64 { return t.User + t.System + t.Nice }

// Total 은 전체 tick 합이다.
func (t CPUTicks) Total() uint64 { return t.Busy() + t.Idle }

// MemInfo 는 한 시점의 메모리 상태다. Used 의 정의는 Activity Monitor 의 "사용된
// 메모리" 와 맞춘다 — wired + active + compressed (FR-STAT-15, D-2). free/inactive 에서
// 역산하지 않는다: macOS 는 유휴 페이지를 free 로 두지 않으므로 그 계산은 사용량을
// 크게 과대평가한다.
type MemInfo struct {
	Total uint64
	Used  uint64
}

// Reader 는 커널 접근면이다. Sampler 가 이 인터페이스에만 의존하므로 테스트에서
// 결정론적 fake 를 주입할 수 있다.
//
// 각 메서드는 서로 독립적으로 실패할 수 있다 — 하나가 ErrUnsupported 를 돌려주더라도
// 나머지는 유효하다 (FR-STAT-7).
type Reader interface {
	CPUTicks() (CPUTicks, error)
	Mem() (MemInfo, error)
	BootTime() (time.Time, error)
	DiskPercent(path string) (float64, error)
}

// CPUPercent 는 두 누적 tick 읽기 사이의 busy 비율(0~100, 소수 1자리)을 낸다.
//
// ok=false 인 경우:
//   - total 이 줄어들었다 (카운터 리셋/래핑)
//   - 두 읽기 사이에 tick 이 늘지 않았다 (같은 시점 또는 분해능 미달)
//
// 두 경우 모두 백분율이 정의되지 않으므로 호출자는 값을 갱신하지 않아야 한다.
func CPUPercent(prev, cur CPUTicks) (float64, bool) {
	if cur.Total() < prev.Total() || cur.Busy() < prev.Busy() {
		return 0, false
	}
	dTotal := cur.Total() - prev.Total()
	if dTotal == 0 {
		return 0, false
	}
	dBusy := cur.Busy() - prev.Busy()
	pct := float64(dBusy) / float64(dTotal) * 100
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return math.Round(pct*10) / 10, true
}

// round1 은 백분율 표시용 소수 1자리 반올림이다.
func round1(v float64) float64 { return math.Round(v*10) / 10 }
