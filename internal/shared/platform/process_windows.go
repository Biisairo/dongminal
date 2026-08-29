//go:build windows

package platform

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// stillActive 는 GetExitCodeProcess 가 "아직 돌고 있다" 를 알리는 값이다
// (STILL_ACTIVE). 실제 종료 코드가 259 인 프로세스와 구별되지 않는 것은
// Windows API 자체의 한계이며, 여기서 더 낫게 만들 수 없다.
const stillActive = 259

type windowsProcess struct{}

// sysProcAttr 는 cmd 의 SysProcAttr 를 확보한다. 호출자가 이미 채워 둔 값을
// 지우지 않는다 — CreationFlags 는 OR 로 얹는다.
func sysProcAttr(cmd *exec.Cmd) *syscall.SysProcAttr {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	return cmd.SysProcAttr
}

// Alive 는 핸들을 열어 종료 코드를 본다. 핸들을 열지 못한 이유가 **권한**이면
// 그 프로세스는 존재하는 것이다 — 없는 pid 는 다른 오류를 낸다 (POSIX 의
// EPERM 처리와 같은 사정).
func (windowsProcess) Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return err == windows.ERROR_ACCESS_DENIED
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		// 핸들은 열렸다 — 존재는 한다. 모른다고 죽었다고 하지 않는다.
		return true
	}
	return code == stillActive
}

// Terminate 는 Ctrl+Break 로 정중히 요청한다. 이것은 **호출자의 콘솔에 붙어
// 있고 자기 프로세스 그룹으로 뜬** 대상에게만 닿는다. 데몬처럼 콘솔이 없는
// 처지에서는 실패하며, 그때는 즉시 종료로 물러선다 (FR-XPR-3).
func (p windowsProcess) Terminate(pid int) error {
	if pid <= 0 {
		return nil
	}
	if err := windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, uint32(pid)); err == nil {
		return nil
	}
	return p.Kill(pid)
}

func (windowsProcess) Kill(pid int) error {
	if pid <= 0 {
		return nil
	}
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return windows.TerminateProcess(h, 1)
}

// Windows 에는 SIGTERM·SIGHUP 이 없다. 상수는 존재하지만 **전달되지 않으므로**
// 나열하지 않는다 — os.Interrupt(Ctrl+C·Ctrl+Break)만 실제로 온다.
func (windowsProcess) ShutdownSignals() []os.Signal {
	return []os.Signal{os.Interrupt}
}

// Detach 는 부모와 수명을 끊는다. POSIX 의 Setsid 에 대응한다 — 부모가 죽어도
// 이 프로세스는 살아남는다.
//
// **DETACHED_PROCESS 가 아니라 CREATE_NO_WINDOW 다.** 둘 다 창을 띄우지 않지만
// 뜻이 다르다.
//
//	DETACHED_PROCESS  콘솔을 **아예 만들지 않는다**
//	CREATE_NO_WINDOW  **새 콘솔**을 만들되 창을 띄우지 않는다
//
// 이 차이가 실기에서 드러났다. DETACHED_PROCESS 로 띄운 데몬 안에서
// CreatePseudoConsole 은 성공하고 초기 시퀀스(16바이트)까지 내보내지만,
// **거기 붙은 셸의 출력이 한 바이트도 나오지 않는다.** 콘솔이 있는
// 프로세스에서는 같은 코드가 정상 동작한다 (doctor 의 도구 검사 266바이트).
//
// 새 콘솔이므로 부모의 콘솔이 닫혀도 이 프로세스에는 닿지 않는다 — 끊어 띄운다는
// 목적은 그대로 지켜진다. CREATE_NEW_PROCESS_GROUP 을 함께 주어 Ctrl+C 가
// 부모에게서 전파되지 않게 한다.
func (windowsProcess) Detach(cmd *exec.Cmd) {
	sysProcAttr(cmd).CreationFlags |= windows.CREATE_NO_WINDOW | windows.CREATE_NEW_PROCESS_GROUP
}

// NewGroup 은 Job Object 를 만들고, 자식을 **중단된 채로** 띄우도록 준비한다.
// 중단이 필요한 이유는 경합이다 — Start 와 Job 배정 사이에 자식이 손자를 낳으면
// 그 손자는 Job 밖에 남아 그룹 종료가 닿지 않는다.
func (windowsProcess) NewGroup(cmd *exec.Cmd) Group {
	g := &windowsGroup{cmd: cmd}
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		g.err = fmt.Errorf("create job object: %w", err)
		return g
	}
	// 마지막 핸들이 닫히면 남은 구성원을 함께 끝낸다 (Group.Close 주석).
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
		},
	}
	if _, err := windows.SetInformationJobObject(job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		g.err = fmt.Errorf("set job limits: %w", err)
		return g
	}
	g.job = job
	sysProcAttr(cmd).CreationFlags |= windows.CREATE_SUSPENDED | windows.CREATE_NEW_PROCESS_GROUP
	return g
}

type windowsGroup struct {
	cmd    *exec.Cmd
	job    windows.Handle
	err    error
	closed bool
}

// Bind 는 자식을 Job 에 넣고 재개한다. 이 순서가 뒤집히면 배정 전에 손자가
// 생길 수 있다 (NewGroup 주석).
func (g *windowsGroup) Bind() error {
	if g.err != nil {
		return g.err
	}
	if g.cmd == nil || g.cmd.Process == nil {
		return fmt.Errorf("bind: 프로세스가 시작되지 않았다")
	}
	pid := uint32(g.cmd.Process.Pid)
	h, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return fmt.Errorf("bind: open process: %w", err)
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(g.job, h); err != nil {
		return fmt.Errorf("bind: assign to job: %w", err)
	}
	if err := resumeProcess(pid); err != nil {
		return fmt.Errorf("bind: %w", err)
	}
	return nil
}

// Terminate 는 그룹 전체에 Ctrl+Break 를 보낸다. CREATE_NEW_PROCESS_GROUP 으로
// 띄웠으므로 그룹 id 는 리더의 pid 다. 닿지 않으면 즉시 종료로 물러선다.
func (g *windowsGroup) Terminate() error {
	if g.err != nil || g.job == 0 {
		return g.err
	}
	if g.cmd != nil && g.cmd.Process != nil {
		if err := windows.GenerateConsoleCtrlEvent(
			windows.CTRL_BREAK_EVENT, uint32(g.cmd.Process.Pid)); err == nil {
			return nil
		}
	}
	return g.Kill()
}

func (g *windowsGroup) Kill() error {
	if g.err != nil || g.job == 0 {
		return g.err
	}
	return windows.TerminateJobObject(g.job, 1)
}

func (g *windowsGroup) Close() error {
	if g.job == 0 || g.closed {
		return nil
	}
	g.closed = true
	return windows.CloseHandle(g.job)
}

// resumeProcess 는 pid 의 스레드를 모두 재개한다. CREATE_SUSPENDED 로 띄운
// 직후이므로 스레드는 하나뿐이지만, 목록을 훑는 편이 그 가정에 기대는 것보다
// 안전하다.
//
// exec.Cmd 는 스레드 핸들을 내주지 않는다. 그래서 스냅샷으로 되찾는다 —
// 이것이 os/exec 로 CREATE_SUSPENDED 를 쓰는 유일한 길이다.
func resumeProcess(pid uint32) error {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return fmt.Errorf("thread snapshot: %w", err)
	}
	defer windows.CloseHandle(snap)

	var entry windows.ThreadEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	resumed := 0
	for err = windows.Thread32First(snap, &entry); err == nil; err = windows.Thread32Next(snap, &entry) {
		if entry.OwnerProcessID != pid {
			continue
		}
		th, terr := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if terr != nil {
			continue
		}
		_, terr = windows.ResumeThread(th)
		windows.CloseHandle(th)
		if terr == nil {
			resumed++
		}
	}
	if resumed == 0 {
		return fmt.Errorf("pid %d 의 스레드를 재개하지 못했다", pid)
	}
	return nil
}
