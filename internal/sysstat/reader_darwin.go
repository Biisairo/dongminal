//go:build darwin

package sysstat

import (
	"encoding/binary"
	"fmt"
	"math"
	"syscall"
	"time"
)

// NewReader 는 이 플랫폼의 Reader 를 만든다.
func NewReader() Reader { return darwinReader{} }

// darwinReader 는 macOS 커널을 직접 읽는다. 외부 프로세스를 fork 하지 않는다
// (FR-STAT-6) — 이 파일의 sysctl·statfs 는 cgo 없이 되고, mach 호출만
// mach_darwin_cgo.go 로 분리돼 있다.
type darwinReader struct{}

// CPUTicks 는 host_statistics(HOST_CPU_LOAD_INFO) 의 누적 tick 을 읽는다 (FR-STAT-1).
func (darwinReader) CPUTicks() (CPUTicks, error) { return machCPUTicks() }

// Mem 은 hw.memsize(총량)와 host_statistics64(HOST_VM_INFO64)(사용량)를 합쳐 낸다
// (FR-STAT-2, FR-STAT-3). vm_stat 프로세스를 fork 하지 않는다.
func (darwinReader) Mem() (MemInfo, error) {
	total, err := memTotal()
	if err != nil {
		return MemInfo{}, err
	}
	used, err := machMemUsed()
	if err != nil {
		// 총량만이라도 유효하면 돌려준다 — 상태바가 total 을 표시할 수 있다.
		return MemInfo{Total: total}, err
	}
	if used > total {
		used = total
	}
	return MemInfo{Total: total, Used: used}, nil
}

// BootTime 은 kern.boottime 을 읽는다 (FR-STAT-4). sysctl 프로세스를 fork 하지 않는다.
func (darwinReader) BootTime() (time.Time, error) { return bootTime() }

// DiskPercent 는 statfs 로 사용률을 낸다 (FR-STAT-5 — 기존 방식 유지).
func (darwinReader) DiskPercent(path string) (float64, error) { return diskPercent(path) }

// memTotal 은 hw.memsize 를 little-endian uint64 로 파싱한다. syscall.Sysctl 은
// 문자열을 돌려주지만 이 MIB 의 값은 바이너리이므로 바이트로 다뤄야 한다.
func memTotal() (uint64, error) {
	raw, err := syscall.Sysctl("hw.memsize")
	if err != nil {
		return 0, fmt.Errorf("sysctl hw.memsize: %w", err)
	}
	return parseSysctlUint64([]byte(raw))
}

// parseSysctlUint64 는 sysctl 이 돌려준 바이트를 uint64 로 읽는다. syscall.Sysctl 이
// 결과를 Go 문자열로 만들 때 마지막 NUL 을 잘라내므로 8바이트가 7바이트로 오는
// 경우가 있다 — 그때는 상위 바이트를 0 으로 보고 채운다.
func parseSysctlUint64(b []byte) (uint64, error) {
	switch {
	case len(b) >= 8:
		return binary.LittleEndian.Uint64(b[:8]), nil
	case len(b) == 0:
		return 0, fmt.Errorf("sysctl: 빈 응답")
	default:
		var buf [8]byte
		copy(buf[:], b)
		return binary.LittleEndian.Uint64(buf[:]), nil
	}
}

// bootTime 은 kern.boottime(struct timeval)의 tv_sec 를 읽는다. 32비트 tv_sec 인
// 환경도 있으므로 응답 길이로 판별한다.
func bootTime() (time.Time, error) {
	raw, err := syscall.Sysctl("kern.boottime")
	if err != nil {
		return time.Time{}, fmt.Errorf("sysctl kern.boottime: %w", err)
	}
	b := []byte(raw)
	if len(b) < 4 {
		return time.Time{}, fmt.Errorf("sysctl kern.boottime: 응답이 %d 바이트", len(b))
	}
	var sec int64
	if len(b) >= 8 {
		sec = int64(binary.LittleEndian.Uint64(padTo8(b)))
	} else {
		sec = int64(binary.LittleEndian.Uint32(b[:4]))
	}
	if sec <= 0 {
		return time.Time{}, fmt.Errorf("sysctl kern.boottime: tv_sec=%d", sec)
	}
	return time.Unix(sec, 0), nil
}

// padTo8 은 8바이트 미만으로 잘려온 값을 0 으로 채워 8바이트로 만든다
// (parseSysctlUint64 와 같은 NUL 절단 사정).
func padTo8(b []byte) []byte {
	if len(b) >= 8 {
		return b[:8]
	}
	buf := make([]byte, 8)
	copy(buf, b)
	return buf
}

func diskPercent(path string) (float64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, fmt.Errorf("statfs %s: %w", path, err)
	}
	if st.Blocks == 0 {
		return 0, fmt.Errorf("statfs %s: blocks=0", path)
	}
	used := st.Blocks - st.Bavail
	return math.Round(float64(used)/float64(st.Blocks)*1000) / 10, nil
}
