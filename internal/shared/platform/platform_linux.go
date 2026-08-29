//go:build linux

package platform

import (
	"os"
	"os/exec"
)

// newPlatform 은 리눅스 번들을 조립한다.
//
// WSL 을 위한 분기가 없다. 브라우저 체인이 수단마다 스스로 가용성을 판정하고
// (browser.go 의 launcher 주석), 나머지 이음매는 WSL 과 리눅스가 같기 때문이다
// (FR-XWS-2). OSKind 가 WSL 을 구별하는 것은 기록·표시를 위해서다.
func newPlatform() Platform {
	return Platform{
		OS:      linuxKind(os.ReadFile),
		Process: posixProcess{},
		Info:    newLinuxProcInfo(),
		PTY:     posixPTY{},
		Shell:   posixShell{env: os.Getenv, stat: statFile},
		IPC:     unixSocketIPC{isSocket: posixIsSocket},
		Paths:   posixPaths{},
		Browser: unixBrowser(exec.LookPath),
	}
}
