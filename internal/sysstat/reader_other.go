//go:build !darwin

// darwin 이 아닌 플랫폼용 대체다. dongminal 은 darwin 전용이며 이 파일이 그 사실을
// 바꾸지 않는다 (SYSTEM_STATS_SRS §5) — 빌드가 깨지지 않게만 한다. 모든 지표가
// ErrUnsupported 이므로 FR-STAT-7 경로로 응답에서 생략된다.
package sysstat

import "time"

// NewReader 는 이 플랫폼의 Reader 를 만든다.
func NewReader() Reader { return unsupportedReader{} }

type unsupportedReader struct{}

func (unsupportedReader) CPUTicks() (CPUTicks, error) { return CPUTicks{}, ErrUnsupported }

func (unsupportedReader) Mem() (MemInfo, error) { return MemInfo{}, ErrUnsupported }

func (unsupportedReader) BootTime() (time.Time, error) { return time.Time{}, ErrUnsupported }

func (unsupportedReader) DiskPercent(string) (float64, error) { return 0, ErrUnsupported }
