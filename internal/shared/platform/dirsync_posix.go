//go:build !windows

package platform

import "os"

// syncDir 은 디렉터리 dir 를 fsync 한다. rename 이 바꾼 디렉터리 항목이 디스크에 닿게 한다
// (FR-ATF-58).
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	if err := d.Sync(); err != nil {
		d.Close()
		return err
	}
	return d.Close()
}
