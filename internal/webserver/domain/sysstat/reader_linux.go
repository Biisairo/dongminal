//go:build linux

package sysstat

import (
	"os"
	"time"
)

// NewReader 는 이 플랫폼의 Reader 를 만든다.
func NewReader() Reader { return linuxReader{} }

// linuxReader 는 /proc 과 statfs 로 읽는다. 외부 프로세스를 fork 하지 않으며
// cgo 도 쓰지 않는다 (FR-XSY-2, NFR-XP-3).
type linuxReader struct{}

const (
	procStatPath    = "/proc/stat"
	procMeminfoPath = "/proc/meminfo"
)

func (linuxReader) CPUTicks() (CPUTicks, error) {
	blob, err := os.ReadFile(procStatPath)
	if err != nil {
		return CPUTicks{}, err
	}
	return parseProcStatCPU(string(blob))
}

func (linuxReader) Mem() (MemInfo, error) {
	blob, err := os.ReadFile(procMeminfoPath)
	if err != nil {
		return MemInfo{}, err
	}
	return parseProcMeminfo(string(blob))
}

func (linuxReader) BootTime() (time.Time, error) {
	blob, err := os.ReadFile(procStatPath)
	if err != nil {
		return time.Time{}, err
	}
	return parseProcStatBootTime(string(blob))
}

// DiskPercent 는 darwin 과 같은 방식이다 — statfs 로 블록 수를 읽는다.
func (linuxReader) DiskPercent(path string) (float64, error) { return diskPercent(path) }
