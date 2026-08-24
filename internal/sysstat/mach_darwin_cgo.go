//go:build darwin && cgo

// mach 호출은 이 파일에만 있다 (SYSTEM_STATS_SRS D-5 의 cgo 격리). CPU tick 과 VM
// 통계는 macOS 에서 mach 인터페이스로만 얻을 수 있고 sysctl 로는 얻을 수 없다.
//
// 실측 비용: host_statistics 538~769ns, host_statistics64 약 10µs, fork 0개.
// 교체 대상이었던 `top -l 1 -n 0` 파이프라인은 1.5초 + 프로세스 3개였다.
package sysstat

/*
#include <mach/mach.h>
#include <mach/mach_host.h>
*/
import "C"

import (
	"fmt"
	"unsafe"
)

// machCPUTicks 는 host_statistics(HOST_CPU_LOAD_INFO) 의 누적 tick 을 읽는다.
func machCPUTicks() (CPUTicks, error) {
	var info C.host_cpu_load_info_data_t
	count := C.mach_msg_type_number_t(C.HOST_CPU_LOAD_INFO_COUNT)
	kr := C.host_statistics(
		C.host_t(C.mach_host_self()),
		C.HOST_CPU_LOAD_INFO,
		C.host_info_t(unsafe.Pointer(&info)),
		&count,
	)
	if kr != C.KERN_SUCCESS {
		return CPUTicks{}, fmt.Errorf("host_statistics(HOST_CPU_LOAD_INFO): kr=%d", int(kr))
	}
	return CPUTicks{
		User:   uint64(info.cpu_ticks[C.CPU_STATE_USER]),
		System: uint64(info.cpu_ticks[C.CPU_STATE_SYSTEM]),
		Idle:   uint64(info.cpu_ticks[C.CPU_STATE_IDLE]),
		Nice:   uint64(info.cpu_ticks[C.CPU_STATE_NICE]),
	}, nil
}

// machMemUsed 는 host_statistics64(HOST_VM_INFO64) 로 사용 중인 바이트를 낸다.
//
// 정의는 wired + active + compressed 다 (FR-STAT-15, D-2). free/inactive 에서
// 역산하지 않는다 — macOS 는 유휴 페이지를 free 로 두지 않아 free 가 0 근처까지
// 내려가므로, 그 계산은 사용량을 5배 가까이 과대평가한다.
//
// 페이지 크기는 하드코딩하지 않고 커널이 보고하는 값을 쓴다 (FR-STAT-16).
func machMemUsed() (uint64, error) {
	var vm C.vm_statistics64_data_t
	count := C.mach_msg_type_number_t(C.HOST_VM_INFO64_COUNT)
	kr := C.host_statistics64(
		C.host_t(C.mach_host_self()),
		C.HOST_VM_INFO64,
		C.host_info64_t(unsafe.Pointer(&vm)),
		&count,
	)
	if kr != C.KERN_SUCCESS {
		return 0, fmt.Errorf("host_statistics64(HOST_VM_INFO64): kr=%d", int(kr))
	}
	pageSize, err := machPageSize()
	if err != nil {
		return 0, err
	}
	pages := uint64(vm.wire_count) + uint64(vm.active_count) + uint64(vm.compressor_page_count)
	return pages * pageSize, nil
}

// machPageSize 는 host_page_size 로 페이지 크기를 얻는다 (FR-STAT-16).
func machPageSize() (uint64, error) {
	var ps C.vm_size_t
	if kr := C.host_page_size(C.host_t(C.mach_host_self()), &ps); kr != C.KERN_SUCCESS {
		return 0, fmt.Errorf("host_page_size: kr=%d", int(kr))
	}
	if ps == 0 {
		return 0, fmt.Errorf("host_page_size: 0")
	}
	return uint64(ps), nil
}
