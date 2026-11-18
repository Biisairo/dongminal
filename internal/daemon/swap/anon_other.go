//go:build !linux

package swap

import "os"

// anonFile 은 연 즉시 이름을 지운 파일이다. 열린 fd 로만 남는다 (R-4: 만들기와 지우기 사이에
// 다른 일을 하지 않는다).
func anonFile(dir string) (*os.File, error) {
	f, err := os.CreateTemp(dir, ".handover-*")
	if err != nil {
		return nil, err
	}
	if err := os.Remove(f.Name()); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
