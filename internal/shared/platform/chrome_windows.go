//go:build windows

package platform

import (
	"fmt"
	"os"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// startupInfoCRT 는 `windows.StartupInfo` 와 같은 배치이며, 이름 없는 두 칸
// (`cbReserved2`·`lpReserved2`)에 이름을 붙였다. x/sys 는 그 칸을 `_` 로 막아
// 두었으므로 같은 모양의 구조체를 포인터로 바꿔 넘긴다.
type startupInfoCRT struct {
	Cb            uint32
	_             *uint16
	Desktop       *uint16
	Title         *uint16
	X             uint32
	Y             uint32
	XSize         uint32
	YSize         uint32
	XCountChars   uint32
	YCountChars   uint32
	FillAttribute uint32
	Flags         uint32
	ShowWindow    uint16
	CbReserved2   uint16
	LpReserved2   *byte
	StdInput      windows.Handle
	StdOutput     windows.Handle
	StdErr        windows.Handle
}

// startPipedWindows 는 `CreateProcessW` 를 직접 부른다 (FR-BRT-5). `os/exec` 의
// `ExtraFiles` 는 Windows 에서 지원되지 않는다(golang/go#26182).
//
// 자식은 **중단된 채로** 떠서 Job Object 에 든 뒤 재개된다 — `NewGroup` 과 같은
// 순서다. 배정 전에 렌더러가 생기면 그 렌더러는 Job 밖에 남는다.
func startPipedWindows(spec PipedSpec) (*PipedProcess, error) {
	sa := &windows.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	var childR, parentW, parentR, childW windows.Handle
	if err := windows.CreatePipe(&childR, &parentW, sa, 0); err != nil {
		return nil, fmt.Errorf("create pipe: %w", err)
	}
	if err := windows.CreatePipe(&parentR, &childW, sa, 0); err != nil {
		windows.CloseHandle(childR)
		windows.CloseHandle(parentW)
		return nil, fmt.Errorf("create pipe: %w", err)
	}
	// 부모 쪽 끝은 상속하지 않는다 — 자식이 들고 있으면 부모가 닫아도 EOF 가 오지 않는다.
	windows.SetHandleInformation(parentW, windows.HANDLE_FLAG_INHERIT, 0)
	windows.SetHandleInformation(parentR, windows.HANDLE_FLAG_INHERIT, 0)
	closeAll := func(hs ...windows.Handle) {
		for _, h := range hs {
			if h != 0 {
				windows.CloseHandle(h)
			}
		}
	}
	nulName, _ := windows.UTF16PtrFromString("NUL")
	nul, err := windows.CreateFile(nulName, windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, sa, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		closeAll(childR, parentW, parentR, childW)
		return nil, fmt.Errorf("open NUL: %w", err)
	}

	reserved := encodeCRTFDs(
		[]uint64{uint64(nul), uint64(nul), uint64(nul), uint64(childR), uint64(childW)},
		[]byte{crtFOPEN | crtFDEV, crtFOPEN | crtFDEV, crtFOPEN | crtFDEV, crtFOPEN | crtFPIPE, crtFOPEN | crtFPIPE},
		int(unsafe.Sizeof(uintptr(0))))
	si := startupInfoCRT{
		Flags:       windows.STARTF_USESTDHANDLES,
		CbReserved2: uint16(len(reserved)),
		LpReserved2: &reserved[0],
		StdInput:    nul,
		StdOutput:   nul,
		StdErr:      nul,
	}
	si.Cb = uint32(unsafe.Sizeof(si))

	app, err := windows.UTF16PtrFromString(spec.Path)
	if err != nil {
		closeAll(childR, parentW, parentR, childW, nul)
		return nil, err
	}
	line, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(append([]string{spec.Path}, spec.Args...)))
	if err != nil {
		closeAll(childR, parentW, parentR, childW, nul)
		return nil, err
	}
	envp, err := envBlock(spec.Env)
	if err != nil {
		closeAll(childR, parentW, parentR, childW, nul)
		return nil, err
	}

	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		closeAll(childR, parentW, parentR, childW, nul)
		return nil, fmt.Errorf("create job object: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		closeAll(childR, parentW, parentR, childW, nul, job)
		return nil, fmt.Errorf("set job limits: %w", err)
	}

	var pi windows.ProcessInformation
	flags := uint32(windows.CREATE_SUSPENDED | windows.CREATE_NO_WINDOW |
		windows.CREATE_UNICODE_ENVIRONMENT | windows.CREATE_NEW_PROCESS_GROUP)
	// 상속 가능한 핸들이 열려 있는 동안 다른 CreateProcess 가 끼어들지 않게 한다.
	syscall.ForkLock.Lock()
	err = windows.CreateProcess(app, line, nil, nil, true, flags, envp, nil,
		(*windows.StartupInfo)(unsafe.Pointer(&si)), &pi)
	syscall.ForkLock.Unlock()
	closeAll(childR, childW, nul)
	if err != nil {
		closeAll(parentW, parentR, job)
		return nil, fmt.Errorf("CreateProcess: %w", err)
	}
	if err := windows.AssignProcessToJobObject(job, pi.Process); err != nil {
		windows.TerminateProcess(pi.Process, 1)
		closeAll(pi.Thread, pi.Process, parentW, parentR, job)
		return nil, fmt.Errorf("assign to job: %w", err)
	}
	if _, err := windows.ResumeThread(pi.Thread); err != nil {
		windows.TerminateJobObject(job, 1)
		closeAll(pi.Thread, pi.Process, parentW, parentR, job)
		return nil, fmt.Errorf("resume: %w", err)
	}
	windows.CloseHandle(pi.Thread)

	toChild := os.NewFile(uintptr(parentW), "cdp-to-child")
	fromChild := os.NewFile(uintptr(parentR), "cdp-from-child")
	var once sync.Once
	var werr error
	done := make(chan struct{})
	wait := func() error {
		once.Do(func() {
			windows.WaitForSingleObject(pi.Process, windows.INFINITE)
			var code uint32
			if err := windows.GetExitCodeProcess(pi.Process, &code); err == nil && code != 0 {
				werr = fmt.Errorf("exit status %d", code)
			}
			windows.CloseHandle(pi.Process)
			windows.CloseHandle(job)
			close(done)
		})
		<-done
		return werr
	}
	var kmu sync.Mutex
	killed := false
	kill := func() error {
		kmu.Lock()
		defer kmu.Unlock()
		if killed {
			return nil
		}
		killed = true
		err := windows.TerminateJobObject(job, 1)
		toChild.Close()
		return err
	}
	return &PipedProcess{ToChild: toChild, FromChild: fromChild, Pid: int(pi.ProcessId), wait: wait, kill: kill}, nil
}
