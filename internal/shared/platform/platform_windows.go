//go:build windows

package platform

import (
	"os"
	"os/exec"
)

// newPlatform 은 Windows 번들을 조립한다 (FR-XPL-3).
func newPlatform() Platform {
	return Platform{
		OS:      Windows,
		Process: windowsProcess{},
		Info:    windowsProcInfo{},
		PTY:     windowsPTY{},
		Shell:   windowsShell{env: os.Getenv, look: exec.LookPath},
		IPC:     unixSocketIPC{isSocket: windowsIsSocket},
		Paths:   windowsPaths{},
		Browser: winBrowser(exec.LookPath, os.Getenv, statFile),
	}
}
