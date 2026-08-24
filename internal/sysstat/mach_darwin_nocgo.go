//go:build darwin && !cgo

// CGO_ENABLED=0 으로 빌드된 darwin 용 대체다. CPU tick 과 VM 통계는 mach 호출로만
// 얻을 수 있으므로 이 빌드에서는 제공할 수 없다. 나머지 지표(총 메모리·부팅시각·
// 디스크)는 sysctl/statfs 경로라 그대로 동작하고, 여기서 막히는 두 지표만 FR-STAT-7
// 에 따라 응답에서 생략된다.
package sysstat

func machCPUTicks() (CPUTicks, error) { return CPUTicks{}, ErrUnsupported }

func machMemUsed() (uint64, error) { return 0, ErrUnsupported }
