//go:build windows

package platform

import (
	"fmt"
	"os"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows 의 의사 터미널은 ConPTY 다 (Windows 10 1809+, C-1). 서드파티 래퍼를
// 쓰지 않고 kernel32 를 직접 부른다 (NFR-XP-2).
//
// os/exec 를 쓸 수 없는 이유는 STARTUPINFOEX 다 — ProcSpec 주석 참조.

var (
	modKernel32             = windows.NewLazySystemDLL("kernel32.dll")
	procCreatePseudoConsole = modKernel32.NewProc("CreatePseudoConsole")
	procResizePseudoConsole = modKernel32.NewProc("ResizePseudoConsole")
	procClosePseudoConsole  = modKernel32.NewProc("ClosePseudoConsole")

	// x/sys/windows 의 ProcThreadAttributeListContainer.Update 는 lpValue 를
	// unsafe.Pointer 로 받는다. 그런데 PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE 은
	// 그 자리에 **핸들 값 자체**를 넣는 속성이다 (MS 의 ConPTY 예제와 같다).
	// 핸들을 포인터로 위장해 넘기면 uintptr→unsafe.Pointer 변환이 되어 실제로
	// 가리키는 것이 없는 포인터가 만들어진다. 그래서 이 한 호출만 직접 한다.
	procUpdateProcThreadAttribute = modKernel32.NewProc("UpdateProcThreadAttribute")
)

const (
	// PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE
	procThreadAttributePseudoConsole = 0x00020016
	extendedStartupInfoPresent       = 0x00080000
)

// packCoord 는 COORD(int16 2개)를 값 전달용 32비트로 포장한다.
func packCoord(cols, rows uint16) uintptr {
	return uintptr(uint32(cols) | uint32(rows)<<16)
}

type windowsPTY struct{}

func (windowsPTY) Start(spec ProcSpec, cols, rows uint16) (Terminal, error) {
	cols, rows = clampSize(cols, rows)
	if err := procCreatePseudoConsole.Find(); err != nil {
		return nil, fmt.Errorf("ConPTY 를 쓸 수 없습니다 — Windows 10 1809 이상이 필요합니다: %w", err)
	}

	// 파이프 두 쌍. inRead·outWrite 는 **자식 쪽 끝**이다.
	//
	// 자식에게 물려줄 것이므로 상속 가능하게 만든다. 부모가 콘솔을 가진 채로
	// 자식을 띄우면 자식이 그 콘솔에 붙어 버리는데(실측: 셸 배너와 프롬프트가
	// 부모 콘솔에 찍히고 의사 콘솔로는 초기화 시퀀스만 왔다), 표준 입출력을
	// 명시해 그 모호함을 없앤다.
	sa := &windows.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(*sa))

	var inRead, inWrite, outRead, outWrite windows.Handle
	if err := windows.CreatePipe(&inRead, &inWrite, sa, 0); err != nil {
		return nil, fmt.Errorf("입력 파이프: %w", err)
	}
	if err := windows.CreatePipe(&outRead, &outWrite, sa, 0); err != nil {
		windows.CloseHandle(inRead)
		windows.CloseHandle(inWrite)
		return nil, fmt.Errorf("출력 파이프: %w", err)
	}
	// 부모가 쥐는 끝은 물려주지 않는다 — 물려주면 자식이 죽어도 파이프가 닫히지
	// 않아 읽기가 EOF 를 보지 못한다.
	for _, h := range []windows.Handle{inWrite, outRead} {
		if err := windows.SetHandleInformation(h, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
			closeAll(inRead, inWrite, outRead, outWrite)
			return nil, fmt.Errorf("핸들 상속 해제: %w", err)
		}
	}

	var hpc windows.Handle
	ret, _, _ := procCreatePseudoConsole.Call(
		packCoord(cols, rows), uintptr(inRead), uintptr(outWrite), 0,
		uintptr(unsafe.Pointer(&hpc)))
	if ret != 0 {
		closeAll(inRead, inWrite, outRead, outWrite)
		return nil, fmt.Errorf("CreatePseudoConsole: %w", windows.Errno(ret))
	}

	// 자식 쪽 끝은 CreateProcess 까지 살아 있어야 한다 — 표준 입출력으로
	// 물려주기 때문이다. 그 뒤에 닫는다.
	pi, err := startInPseudoConsole(spec, hpc, inRead, outWrite)
	windows.CloseHandle(inRead)
	windows.CloseHandle(outWrite)
	if err != nil {
		procClosePseudoConsole.Call(uintptr(hpc))
		windows.CloseHandle(inWrite)
		windows.CloseHandle(outRead)
		return nil, err
	}

	return &windowsTerminal{
		hpc:     hpc,
		in:      os.NewFile(uintptr(inWrite), "conpty-in"),
		out:     os.NewFile(uintptr(outRead), "conpty-out"),
		process: pi.Process,
		thread:  pi.Thread,
		pid:     int(pi.ProcessId),
		cols:    cols,
		rows:    rows,
	}, nil
}

// startInPseudoConsole 은 hpc 에 붙은 프로세스를 띄운다. 속성 목록에 HPCON 을
// 싣는 것이 ConPTY 세션의 전부다.
func startInPseudoConsole(spec ProcSpec, hpc, childIn, childOut windows.Handle) (*windows.ProcessInformation, error) {
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return nil, fmt.Errorf("속성 목록: %w", err)
	}
	defer attrs.Delete()
	ok, _, callErr := procUpdateProcThreadAttribute.Call(
		uintptr(unsafe.Pointer(attrs.List())),
		0, // dwFlags — 예약됨
		procThreadAttributePseudoConsole,
		uintptr(hpc), // lpValue = HPCON 값 자체
		unsafe.Sizeof(hpc),
		0, 0)
	if ok == 0 {
		return nil, fmt.Errorf("속성 설정: %w", callErr)
	}

	var siEx windows.StartupInfoEx
	siEx.ProcThreadAttributeList = attrs.List()
	siEx.Cb = uint32(unsafe.Sizeof(siEx))
	// 표준 입출력을 의사 콘솔의 자식 쪽 끝으로 못박는다. 이것이 없으면 부모에
	// 콘솔이 있을 때 자식이 그쪽에 붙는다 (Start 의 주석).
	siEx.Flags |= windows.STARTF_USESTDHANDLES
	siEx.StdInput = childIn
	siEx.StdOutput = childOut
	siEx.StdErr = childOut

	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(spec.Args))
	if err != nil {
		return nil, fmt.Errorf("명령줄: %w", err)
	}
	appName, err := windows.UTF16PtrFromString(spec.Path)
	if err != nil {
		return nil, fmt.Errorf("실행 파일: %w", err)
	}
	var dir *uint16
	if spec.Dir != "" {
		if dir, err = windows.UTF16PtrFromString(spec.Dir); err != nil {
			return nil, fmt.Errorf("작업 디렉터리: %w", err)
		}
	}
	env, err := envBlock(dedupEnv(spec.Env, envKeyFolded))
	if err != nil {
		return nil, fmt.Errorf("환경 변수: %w", err)
	}

	var pi windows.ProcessInformation
	// 표준 입출력을 물려주므로 상속을 켠다. 상속 가능한 핸들은 방금 만든
	// 자식 쪽 파이프 끝 둘뿐이다.
	flags := uint32(extendedStartupInfoPresent | windows.CREATE_UNICODE_ENVIRONMENT)
	if err := windows.CreateProcess(appName, cmdLine, nil, nil, true,
		flags, env, dir, (*windows.StartupInfo)(unsafe.Pointer(&siEx)), &pi); err != nil {
		return nil, fmt.Errorf("CreateProcess %s: %w", spec.Path, err)
	}
	return &pi, nil
}

// closeAll 은 핸들 여럿을 닫는다. 실패 경로에서 하나씩 적는 것을 줄인다.
func closeAll(hs ...windows.Handle) {
	for _, h := range hs {
		if h != 0 {
			windows.CloseHandle(h)
		}
	}
}

// envBlock 은 "K=V" 목록을 CreateProcess 가 받는 UTF-16 블록으로 바꾼다.
// 각 항목이 NUL 로 끝나고 전체가 NUL 하나로 더 닫힌다.
func envBlock(env []string) (*uint16, error) {
	if len(env) == 0 {
		return nil, nil
	}
	var block []uint16
	for _, e := range env {
		if e == "" {
			continue
		}
		u, err := windows.UTF16FromString(e)
		if err != nil {
			return nil, err
		}
		block = append(block, u...)
	}
	if len(block) == 0 {
		return nil, nil
	}
	block = append(block, 0)
	return &block[0], nil
}

type windowsTerminal struct {
	hpc     windows.Handle
	in      *os.File
	out     *os.File
	process windows.Handle
	thread  windows.Handle
	pid     int

	// ConPTY 에는 크기를 되묻는 API 가 없다. 마지막으로 정한 값을 들고 있는다.
	mu        sync.Mutex
	cols      uint16
	rows      uint16
	closeOnce sync.Once
}

func (t *windowsTerminal) Read(b []byte) (int, error)  { return t.out.Read(b) }
func (t *windowsTerminal) Write(b []byte) (int, error) { return t.in.Write(b) }

func (t *windowsTerminal) Close() error {
	t.closeOnce.Do(func() {
		// 의사 콘솔을 먼저 닫아야 자식이 EOF 를 본다.
		procClosePseudoConsole.Call(uintptr(t.hpc))
		t.in.Close()
		t.out.Close()
		if t.thread != 0 {
			windows.CloseHandle(t.thread)
			t.thread = 0
		}
	})
	return nil
}

func (t *windowsTerminal) Resize(cols, rows uint16) error {
	ret, _, _ := procResizePseudoConsole.Call(uintptr(t.hpc), packCoord(cols, rows))
	if ret != 0 {
		return fmt.Errorf("ResizePseudoConsole: %w", windows.Errno(ret))
	}
	t.mu.Lock()
	t.cols, t.rows = cols, rows
	t.mu.Unlock()
	return nil
}

func (t *windowsTerminal) Size() (uint16, uint16, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.cols, t.rows, nil
}

// Windows 에 전경 프로세스 그룹이라는 개념은 없다 (FR-XPT-5).
func (t *windowsTerminal) ForegroundPGID() (int, bool) { return 0, false }

func (t *windowsTerminal) PID() int { return t.pid }

func (t *windowsTerminal) Wait() error {
	if t.process == 0 {
		return nil
	}
	if _, err := windows.WaitForSingleObject(t.process, windows.INFINITE); err != nil {
		return err
	}
	var code uint32
	if err := windows.GetExitCodeProcess(t.process, &code); err != nil {
		return err
	}
	windows.CloseHandle(t.process)
	t.process = 0
	if code != 0 {
		return fmt.Errorf("종료 코드 %d", code)
	}
	return nil
}

func (t *windowsTerminal) Terminate() error { return windowsProcess{}.Terminate(t.pid) }

func (t *windowsTerminal) Kill() error { return windowsProcess{}.Kill(t.pid) }
