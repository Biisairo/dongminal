//go:build !windows

package sysstat

import (
	"fmt"
	"math"
	"syscall"
)

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
