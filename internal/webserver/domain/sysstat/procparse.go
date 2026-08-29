package sysstat

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// 리눅스 /proc 의 **순수** 해석부다. 읽기는 reader_linux.go 가 하고 여기는
// 문자열만 다룬다 — build tag 가 없으므로 어느 호스트에서도 검증된다
// (CROSS_PLATFORM_SRS §4.2).

// parseProcStatCPU 는 /proc/stat 의 첫 `cpu` 줄에서 누적 tick 을 읽는다.
// 열 순서는 user nice system idle iowait irq softirq ... 다.
//
// iowait 는 idle 에 더한다 — 그 시간 동안 CPU 는 일하고 있지 않다. darwin 의
// HOST_CPU_LOAD_INFO 에 iowait 항목이 없어 두 플랫폼의 백분율 의미를 맞춘다.
func parseProcStatCPU(content string) (CPUTicks, error) {
	for _, line := range strings.Split(content, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 || f[0] != "cpu" {
			continue
		}
		vals := make([]uint64, 0, 5)
		for _, s := range f[1:min(len(f), 6)] {
			n, err := strconv.ParseUint(s, 10, 64)
			if err != nil {
				return CPUTicks{}, fmt.Errorf("/proc/stat cpu 열 해석: %w", err)
			}
			vals = append(vals, n)
		}
		t := CPUTicks{User: vals[0], Nice: vals[1], System: vals[2], Idle: vals[3]}
		if len(vals) > 4 {
			t.Idle += vals[4] // iowait
		}
		return t, nil
	}
	return CPUTicks{}, fmt.Errorf("/proc/stat 에 cpu 줄이 없다")
}

// parseProcStatBootTime 은 /proc/stat 의 btime(부팅 시각, epoch 초)을 읽는다.
func parseProcStatBootTime(content string) (time.Time, error) {
	for _, line := range strings.Split(content, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 || f[0] != "btime" {
			continue
		}
		sec, err := strconv.ParseInt(f[1], 10, 64)
		if err != nil {
			return time.Time{}, fmt.Errorf("/proc/stat btime 해석: %w", err)
		}
		return time.Unix(sec, 0), nil
	}
	return time.Time{}, fmt.Errorf("/proc/stat 에 btime 이 없다")
}

// parseProcMeminfo 는 총량과 사용량을 낸다.
//
// 사용량은 MemTotal - MemAvailable 이다. MemFree 를 쓰면 캐시·버퍼가 전부
// "사용 중"으로 잡혀 크게 과대평가된다 — darwin 에서 free/inactive 로 역산했다
// 정정한 것과 같은 함정이다 (SYSTEM_STATS_SRS D-2).
//
// MemAvailable 이 없는 낡은 커널(3.14 미만)에서는 MemFree+Buffers+Cached 로
// 근사한다. 값은 kB 단위다.
func parseProcMeminfo(content string) (MemInfo, error) {
	fields := map[string]uint64{}
	for _, line := range strings.Split(content, "\n") {
		key, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		f := strings.Fields(rest)
		if len(f) == 0 {
			continue
		}
		if n, err := strconv.ParseUint(f[0], 10, 64); err == nil {
			fields[key] = n * 1024
		}
	}
	total, ok := fields["MemTotal"]
	if !ok || total == 0 {
		return MemInfo{}, fmt.Errorf("/proc/meminfo 에 MemTotal 이 없다")
	}
	avail, ok := fields["MemAvailable"]
	if !ok {
		avail = fields["MemFree"] + fields["Buffers"] + fields["Cached"]
	}
	if avail > total {
		avail = total
	}
	return MemInfo{Total: total, Used: total - avail}, nil
}
