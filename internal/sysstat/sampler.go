package sysstat

import (
	"sync"
	"time"
)

// DefaultInterval 은 샘플 주기다 (SYSTEM_STATS_SRS D-3). 커널 호출이 µs 단위이므로
// 클라이언트 폴링 기본값(3s) 보다 짧게 두어 체감 신선도를 유지한다.
const DefaultInterval = 2 * time.Second

// Snapshot 은 샘플러가 유지하는 최신 지표다. 각 지표는 독립적으로 유효/무효일 수
// 있다 — 커널 호출이 실패한 지표는 마지막 유효값을 유지하고, 한 번도 유효하지 않았던
// 지표는 Valid 플래그가 false 로 남는다 (FR-STAT-7).
type Snapshot struct {
	CPU      float64
	CPUValid bool

	Mem      MemInfo
	MemValid bool

	DiskPct   float64
	DiskValid bool

	BootTime  time.Time
	BootValid bool
}

// Sampler 는 커널 값을 주기적으로 읽어 Snapshot 을 갱신한다.
//
// 요청 경로에서 커널을 호출하지 않는 것이 존재 이유다 (FR-STAT-9). 커널 호출 횟수는
// 접속 클라이언트 수와 무관하게 주기당 1회다 (FR-STAT-11).
type Sampler struct {
	r        Reader
	interval time.Duration
	diskPath string

	mu   sync.RWMutex
	snap Snapshot

	// prev 는 CPU tick 차분의 기준점이다. hasPrev 이전에는 CPU% 를 낼 수 없다
	// (FR-STAT-12).
	prev    CPUTicks
	hasPrev bool
}

// NewSampler 는 샘플러를 만든다. interval 이 0 이하면 DefaultInterval 을 쓴다.
// diskPath 가 비면 "/" 를 쓴다.
func NewSampler(r Reader, interval time.Duration, diskPath string) *Sampler {
	if interval <= 0 {
		interval = DefaultInterval
	}
	if diskPath == "" {
		diskPath = "/"
	}
	return &Sampler{r: r, interval: interval, diskPath: diskPath}
}

// Start 는 샘플러 goroutine 을 띄운다. stopCh 가 닫히면 종료한다 (FR-STAT-13).
//
// 기동 즉시 1회 샘플링해 CPU tick 기준점을 잡고 CPU 외 지표를 채운다. 그래서 서버
// 기동 직후의 첫 요청도 메모리·디스크·부팅시각은 유효한 값을 받는다. CPU 는 두 번째
// 샘플부터 유효하다 — 차분이 성립해야 하기 때문이다 (FR-STAT-12).
func (s *Sampler) Start(stopCh <-chan struct{}) {
	s.sample()
	go func() {
		t := time.NewTicker(s.interval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				s.sample()
			case <-stopCh:
				return
			}
		}
	}()
}

// Snapshot 은 최신 스냅샷의 사본을 반환한다. 잠금 구간에 커널 호출이 없으므로
// 요청 경로가 블로킹되지 않는다 (FR-STAT-10).
func (s *Sampler) Snapshot() Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.snap
}

// sample 은 한 주기의 수집이다. 지표별로 독립 처리하므로 하나의 실패가 나머지를
// 막지 않는다 (FR-STAT-7).
func (s *Sampler) sample() {
	cur, cpuErr := s.r.CPUTicks()
	mem, memErr := s.r.Mem()
	boot, bootErr := s.r.BootTime()
	disk, diskErr := s.r.DiskPercent(s.diskPath)

	s.mu.Lock()
	defer s.mu.Unlock()

	if cpuErr == nil {
		if s.hasPrev {
			if pct, ok := CPUPercent(s.prev, cur); ok {
				s.snap.CPU = pct
				s.snap.CPUValid = true
			}
		}
		s.prev = cur
		s.hasPrev = true
	}
	if memErr == nil {
		s.snap.Mem = mem
		s.snap.MemValid = true
	}
	if bootErr == nil {
		s.snap.BootTime = boot
		s.snap.BootValid = true
	}
	if diskErr == nil {
		s.snap.DiskPct = round1(disk)
		s.snap.DiskValid = true
	}
}
