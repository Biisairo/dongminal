//go:build windows

package platform

import (
	"fmt"
	"log"
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

	// 파이프 두 쌍. inRead·outWrite 는 ConPTY 가 가져갈 끝이고, 부모는
	// inWrite(자식에게 쓰기)·outRead(자식에서 읽기)를 쥔다. 상속은 필요 없다 —
	// 자식은 이 파이프를 직접 만지지 않고 의사 콘솔을 통해서만 오간다.
	var inRead, inWrite, outRead, outWrite windows.Handle
	if err := windows.CreatePipe(&inRead, &inWrite, nil, 0); err != nil {
		return nil, fmt.Errorf("입력 파이프: %w", err)
	}
	if err := windows.CreatePipe(&outRead, &outWrite, nil, 0); err != nil {
		closeAll(inRead, inWrite)
		return nil, fmt.Errorf("출력 파이프: %w", err)
	}

	var hpc windows.Handle
	ret, _, _ := procCreatePseudoConsole.Call(
		packCoord(cols, rows), uintptr(inRead), uintptr(outWrite), 0,
		uintptr(unsafe.Pointer(&hpc)))
	if ret != 0 {
		closeAll(inRead, inWrite, outRead, outWrite)
		return nil, fmt.Errorf("CreatePseudoConsole: %w", windows.Errno(ret))
	}

	// ConPTY 가 자기 몫으로 복제해 갔으므로 부모의 사본은 닫는다. 닫지 않으면
	// 자식이 끝나도 읽기가 EOF 를 보지 못한다.
	windows.CloseHandle(inRead)
	windows.CloseHandle(outWrite)

	pi, err := startInPseudoConsole(spec, hpc)
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
func startInPseudoConsole(spec ProcSpec, hpc windows.Handle) (*windows.ProcessInformation, error) {
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

	// STARTF_USESTDHANDLES 를 세우되 **핸들 셋은 0 인 채로 둔다.** 이 조합이
	// ConPTY 배관의 마지막 조각이다 (§11.8).
	//
	// 플래그가 없으면 CreateProcess 는 자식의 표준 입출력을 **부모에게서**
	// 물려준다. 부모에게 콘솔이 있으면 그 콘솔 핸들이 넘어가고, 자식은 의사
	// 콘솔에 붙기는 하지만(그래서 제목 OSC 는 의사 콘솔로 온다) 정작 글자는
	// 부모 콘솔에 그린다 — §11.6 에서 본 "제목만 오고 텍스트는 CI 로그로
	// 새는" 조합이 이것이다.
	//
	// 0 을 넣는 것이 요점이다. 파이프 끝을 넣으면(146c99a) ConPTY 와 자식이
	// 같은 파이프를 두고 경쟁해 더 나빠진다 — 그래서 d4a9e67 이 되돌렸다.
	// 물려줄 것을 지정하는 것이 아니라 **물려받지 않게 하는 것**이 목적이다.
	// 빈 자리는 의사 콘솔이 채운다.
	//
	// 검증된 두 구현이 모두 이렇게 한다: UserExistsError/conpty 의
	// getStartupInfoExForPTY, aymanbagabas/go-pty 의 Cmd.start.
	siEx.StartupInfo.Flags |= windows.STARTF_USESTDHANDLES
	log.Printf("[conpty] sizeof(StartupInfoEx)=%d sizeof(StartupInfo)=%d sizeof(HPCON)=%d attr=%#x flags=%#x",
		unsafe.Sizeof(siEx), unsafe.Sizeof(siEx.StartupInfo), unsafe.Sizeof(hpc),
		procThreadAttributePseudoConsole, extendedStartupInfoPresent|windows.CREATE_UNICODE_ENVIRONMENT)

	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(spec.Args))
	if err != nil {
		return nil, fmt.Errorf("명령줄: %w", err)
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
	// lpApplicationName 은 nil 이다 — 실행 파일은 명령줄의 첫 토큰에서 찾는다.
	// MS 의 ConPTY 예제와 같은 형태로 맞춘다. 상속을 켜는 것도 같은 이유다:
	// 물려줄 상속 가능한 핸들이 없으므로 무해하고, 자식의 콘솔 결선이 예제와
	// 같은 경로를 타게 된다.
	flags := uint32(extendedStartupInfoPresent | windows.CREATE_UNICODE_ENVIRONMENT)
	if err := windows.CreateProcess(nil, cmdLine, nil, nil, true,
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
