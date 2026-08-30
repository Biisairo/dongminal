package platform

import (
	"io"
	"strings"
)

// ProcSpec 은 의사 터미널에 붙일 프로세스의 명세다.
//
// *exec.Cmd 가 아닌 이유는 Windows 다. ConPTY 세션에 프로세스를 붙이려면
// STARTUPINFOEX 의 PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE 속성에 HPCON 을 실어
// CreateProcess 를 불러야 하는데, os/exec 도 syscall.SysProcAttr(windows) 도
// 프로세스/스레드 속성 목록을 노출하지 않는다. 그래서 Windows 어댑터는
// exec.Cmd.Start() 를 쓸 수 없고 프로세스를 스스로 띄워야 한다
// (CROSS_PLATFORM_SRS §2.4, FR-XPT-1).
type ProcSpec struct {
	Path string   // 실행 파일
	Args []string // Args[0] 을 포함한 전체 argv
	Env  []string // "K=V" 목록. 완전한 환경이며 상속하지 않는다
	Dir  string   // 작업 디렉터리
}

// dedupEnv 는 중복 키를 **뒤엣것으로** 정리한다. 호출자가
// `append(os.Environ(), 덧붙일것...)` 로 환경을 만드는 것이 관례이므로,
// 정리하지 않으면 덧붙인 값이 아니라 원본이 이긴다.
//
// os/exec 는 Start() 안에서 이것을 해 준다. ConPTY 경로는 os/exec 를 쓸 수
// 없으므로(§2.4) 그 정리가 사라진다 — 그래서 어댑터가 아니라 여기서, 두
// 구현이 같은 규칙을 쓰도록 한다.
//
// Windows 는 환경변수 이름의 대소문자를 구분하지 않으므로 접은 이름으로
// 비교한다. fold 가 그 차이를 담는다.
//
// "=" 로 시작하는 항목은 키가 없는 특수 항목이다(Windows 의 드라이브별 cwd).
// 건드리지 않고 그대로 앞에 둔다.
func dedupEnv(env []string, fold func(string) string) []string {
	seen := make(map[string]int, len(env))
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if kv == "" {
			continue
		}
		if strings.HasPrefix(kv, "=") {
			out = append(out, kv)
			continue
		}
		k, _, ok := strings.Cut(kv, "=")
		if !ok {
			out = append(out, kv)
			continue
		}
		key := fold(k)
		if i, dup := seen[key]; dup {
			out[i] = kv // 뒤엣것이 이긴다
			continue
		}
		seen[key] = len(out)
		out = append(out, kv)
	}
	return out
}

// envKeyAsIs·envKeyFolded 는 dedupEnv 의 이름 비교 규칙이다.
func envKeyAsIs(k string) string   { return k }
func envKeyFolded(k string) string { return strings.ToUpper(k) }

// clampSize 는 터미널 크기의 하한을 세운다.
//
// **ConPTY 는 0 을 받으면 E_INVALIDARG 로 실패한다.** POSIX 는 0x0 을 받아도
// 커널이 기본값을 주므로 그냥 뜬다 — 그래서 크기 0 은 POSIX 에서 아무 증상도
// 내지 않다가 Windows 에서만 "터미널이 안 뜬다" 로 나타난다. 그 함정을 두
// 어댑터가 같은 자리에서 막는다.
func clampSize(cols, rows uint16) (uint16, uint16) {
	if cols == 0 {
		cols = defaultCols
	}
	if rows == 0 {
		rows = defaultRows
	}
	return cols, rows
}

const (
	defaultCols = 80
	defaultRows = 24
)

// PTY 는 의사 터미널을 만드는 능력이다.
type PTY interface {
	// Start 는 새 의사 터미널을 만들고 그 안에 spec 을 띄운다.
	Start(spec ProcSpec, cols, rows uint16) (Terminal, error)
}

// Terminal 은 의사 터미널의 마스터측 **과 거기 붙은 프로세스**를 함께 소유한다.
//
// 둘을 한 인터페이스로 묶은 것은 편의가 아니라 필연이다. POSIX 에서는 ptmx
// 파일과 exec.Cmd 가 따로지만, Windows ConPTY 에서는 입력 파이프·출력 파이프·
// HPCON·프로세스 핸들이 한 덩어리로 만들어지고 함께 정리되어야 한다.
type Terminal interface {
	// Read/Write 는 터미널 입출력이다. Close 는 터미널을 닫는다 — 프로세스를
	// 끝내지는 않는다.
	io.ReadWriteCloser

	Resize(cols, rows uint16) error
	Size() (cols, rows uint16, err error)

	// ForegroundPGID 는 **셸이 아닌 전경 프로그램**의 프로세스 그룹 id 다.
	//
	// ok=false 는 세 경우를 하나로 묶는다: 전경 프로그램이 없다(셸이 프롬프트에서
	// 대기), 조회에 실패했다, 이 플랫폼에 그 개념이 없다. 호출자에게는 셋 다
	// "붙일 이름이 없다" 로 같으므로 나누지 않는다 (FR-TAN-6/24 승계).
	//
	// 셸 자신과 비교하는 일까지 이 메서드가 한다 — 셸의 프로세스 그룹을 읽는
	// 방법 역시 OS 마다 다르기 때문이다.
	ForegroundPGID() (pgid int, ok bool)

	// PID 는 터미널에 붙은 프로세스다. 0 이면 없다.
	PID() int

	// Wait 는 프로세스 종료를 기다리고 자원을 수확한다.
	Wait() error

	// Terminate 는 정중한 종료 요청, Kill 은 즉시 종료다. 의미론은
	// Process 인터페이스와 같다.
	Terminate() error
	Kill() error
}
