//go:build darwin

package platform

import "os"

// newPlatform 은 darwin 번들을 조립한다. 조립은 이 파일에서 끝나고, 그 뒤로는
// 인터페이스가 가른다 — 이 파일 밖에는 OS 를 묻는 코드가 없다 (FR-XPL-3).
func newPlatform() Platform {
	return Platform{
		OS:      Darwin,
		Process: posixProcess{},
		Info:    darwinProcInfo{run: execRun},
		PTY:     posixPTY{},
		Shell:   posixShell{env: os.Getenv, stat: statFile},
		IPC:     unixSocketIPC{isSocket: posixIsSocket},
		Paths:   posixPaths{},
		Browser: macBrowser(),
	}
}
