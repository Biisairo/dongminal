//go:build windows

package peer

import (
	"path/filepath"

	"golang.org/x/sys/windows"
)

// realDir 는 Windows 에서 경로의 최종 위치다. filepath.EvalSymlinks 는 Go 1.23 부터
// junction(mount point)을 풀지 않으므로, 핸들을 열어 GetFinalPathNameByHandle 로 묻는다
// (리뷰 S-8). 허용 폴더 안의 junction 으로 밖을 가리키는 길을 막는다.
func realDir(path string) (string, error) {
	p, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", err
	}
	name, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(name, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
	if err != nil {
		return "", err
	}
	if int(n) > len(buf) {
		buf = make([]uint16, n)
		if n, err = windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0); err != nil {
			return "", err
		}
	}
	return trimFinalPathPrefix(windows.UTF16ToString(buf[:n])), nil
}
