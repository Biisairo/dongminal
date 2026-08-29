//go:build windows

package sysstat

import (
	"fmt"
	"math"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// x/sys/windows 는 아래 넷을 감싸 두지 않았다. 서드파티 의존을 늘리지 않기
// 위해 kernel32 를 직접 부른다 (NFR-XP-2).
var (
	modKernel32              = windows.NewLazySystemDLL("kernel32.dll")
	procGetSystemTimes       = modKernel32.NewProc("GetSystemTimes")
	procGlobalMemoryStatusEx = modKernel32.NewProc("GlobalMemoryStatusEx")
	procGetTickCount64       = modKernel32.NewProc("GetTickCount64")
)

// memoryStatusEx 는 MEMORYSTATUSEX 다. 필드 순서와 크기가 곧 ABI 이므로
// 쓰지 않는 항목도 그대로 둔다.
type memoryStatusEx struct {
	Length               uint32
	MemoryLoad           uint32
	TotalPhys            uint64
	AvailPhys            uint64
	TotalPageFile        uint64
	AvailPageFile        uint64
	TotalVirtual         uint64
	AvailVirtual         uint64
	AvailExtendedVirtual uint64
}

// NewReader 는 이 플랫폼의 Reader 를 만든다.
func NewReader() Reader { return windowsReader{} }

// windowsReader 는 WinAPI 로 직접 읽는다. 외부 프로세스를 fork 하지 않으며
// cgo 도 쓰지 않는다 (FR-XSY-3, NFR-XP-3).
type windowsReader struct{}

// CPUTicks 는 GetSystemTimes 의 누적 시간(100ns 단위)을 tick 으로 쓴다.
//
// 단위는 중요하지 않다 — 백분율은 두 시점의 **차분 비율**로 나오므로 단위가
// 약분된다 (CPUTicks 주석). kernel 시간에는 idle 이 포함되어 있으므로 빼야
// system 이 된다. Windows 에는 nice 개념이 없다.
func (windowsReader) CPUTicks() (CPUTicks, error) {
	var idle, kernel, user windows.Filetime
	ok, _, err := procGetSystemTimes.Call(
		uintptr(unsafe.Pointer(&idle)),
		uintptr(unsafe.Pointer(&kernel)),
		uintptr(unsafe.Pointer(&user)))
	if ok == 0 {
		return CPUTicks{}, fmt.Errorf("GetSystemTimes: %w", err)
	}
	idleTicks := filetimeTicks(idle)
	kernelTicks := filetimeTicks(kernel)
	if kernelTicks < idleTicks {
		return CPUTicks{}, fmt.Errorf("GetSystemTimes: kernel < idle")
	}
	return CPUTicks{
		User:   filetimeTicks(user),
		System: kernelTicks - idleTicks,
		Idle:   idleTicks,
	}, nil
}

func filetimeTicks(ft windows.Filetime) uint64 {
	return uint64(ft.HighDateTime)<<32 | uint64(ft.LowDateTime)
}

// Mem 은 GlobalMemoryStatusEx 를 쓴다. Windows 가 "사용 가능" 으로 보고하는
// 값을 그대로 믿는다 — darwin 의 wired+active+compressed 정의는 그 OS 고유이며
// 여기서 흉내내지 않는다 (FR-XSY-4).
func (windowsReader) Mem() (MemInfo, error) {
	var st memoryStatusEx
	st.Length = uint32(unsafe.Sizeof(st))
	ok, _, err := procGlobalMemoryStatusEx.Call(uintptr(unsafe.Pointer(&st)))
	if ok == 0 {
		return MemInfo{}, fmt.Errorf("GlobalMemoryStatusEx: %w", err)
	}
	if st.TotalPhys == 0 {
		return MemInfo{}, fmt.Errorf("GlobalMemoryStatusEx: total=0")
	}
	used := st.TotalPhys
	if st.AvailPhys < st.TotalPhys {
		used = st.TotalPhys - st.AvailPhys
	}
	return MemInfo{Total: st.TotalPhys, Used: used}, nil
}

// BootTime 은 가동 시간을 지금에서 빼서 낸다. Windows 에는 부팅 시각을 직접
// 주는 API 가 없다.
func (windowsReader) BootTime() (time.Time, error) {
	ms, _, _ := procGetTickCount64.Call()
	if ms == 0 {
		return time.Time{}, fmt.Errorf("GetTickCount64: 0")
	}
	return time.Now().Add(-time.Duration(ms) * time.Millisecond), nil
}

func (windowsReader) DiskPercent(path string) (float64, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, fmt.Errorf("경로 변환 %s: %w", path, err)
	}
	var freeToCaller, total, free uint64
	if err := windows.GetDiskFreeSpaceEx(p, &freeToCaller, &total, &free); err != nil {
		return 0, fmt.Errorf("GetDiskFreeSpaceEx %s: %w", path, err)
	}
	if total == 0 {
		return 0, fmt.Errorf("GetDiskFreeSpaceEx %s: total=0", path)
	}
	// 사용률의 분모는 전체이고, 남은 양은 **호출자가 쓸 수 있는** 양이다 —
	// 할당량이 걸린 계정에서 free 를 쓰면 실제보다 여유롭게 보인다.
	used := total - freeToCaller
	return math.Round(float64(used)/float64(total)*1000) / 10, nil
}
