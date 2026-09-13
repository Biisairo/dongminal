package platform

import (
	"bufio"
	"fmt"
	"io"
	"os/exec"
	"sync"
)

// StartPipe 는 spec 을 **PTY 없이** 띄운다 — stdin·stdout 파이프가 터미널 자리에
// 선다 (M8_UNIFIED_SRS FR-AGT-2·3, §9.3 ⑤ "(c) 전송이 필요한 호출"). 에이전트
// 도구의 프로토콜 프레임이 이 길로 오간다.
//
// 돌려주는 것이 Terminal 인 이유가 요점이다: 도구 하나의 수명(읽기 루프·종료·
// 수확)은 PTY 와 같은 코드가 들고, 터미널 고유 호출(Resize·Size·ForegroundPGID)은
// 여기서 **오류가 아니라 무동작**으로 끝난다 — 종류를 묻는 자리가 소비자 쪽으로
// 새지 않는다 (D-U-4).
//
// stderr 는 줄 단위로 onStderr 에 온다 (D-C-6). 출력 스트림에 섞지 않는다 — 청크는
// 줄과 무관해 JSON 한 줄이 갈린다. nil 이면 버린다.
func StartPipe(spec ProcSpec, onStderr func(line string)) (Terminal, error) {
	cmd := exec.Command(spec.Path, spec.Args[1:]...)
	cmd.Args = spec.Args
	cmd.Env = dedupEnv(spec.Env, envKeyAsIs)
	cmd.Dir = spec.Dir
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("pipe start %s (cwd=%s): %w", spec.Path, spec.Dir, err)
	}
	t := &pipeTerminal{cmd: cmd, stdin: stdin, stdout: stdout}
	t.stderrDone = make(chan struct{})
	go func() {
		defer close(t.stderrDone)
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			if onStderr != nil {
				onStderr(sc.Text())
			}
		}
	}()
	return t, nil
}

// pipeTerminal 은 파이프 셋과 프로세스를 한 덩어리로 든다.
type pipeTerminal struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	// stderrDone 은 stderr 를 다 읽었다는 신호다. Wait 가 이것을 기다린다 —
	// os/exec 의 Wait 는 StderrPipe 를 우리가 읽고 있을 때 그 파이프를 닫으므로,
	// 먼저 기다리지 않으면 마지막 줄이 잘린다.
	stderrDone chan struct{}
	closeOnce  sync.Once
	closeErr   error
	waitOnce   sync.Once
	waitErr    error
}

func (t *pipeTerminal) Read(b []byte) (int, error)  { return t.stdout.Read(b) }
func (t *pipeTerminal) Write(b []byte) (int, error) { return t.stdin.Write(b) }

// Close 는 stdin 을 닫는다 — 프로토콜 표면의 정중한 종료가 그것이다 (§9.1 U-7:
// 셋 다 stdin EOF). stdout 은 닫지 않는다: 읽기 루프가 EOF 로 끝나야 도구가 정상
// 종료 경로를 지난다.
func (t *pipeTerminal) Close() error {
	t.closeOnce.Do(func() { t.closeErr = t.stdin.Close() })
	return t.closeErr
}

// Resize·Size·ForegroundPGID — 파이프에 없는 개념이다. 오류가 아니라 무동작 (FR-AGT-2).
func (t *pipeTerminal) Resize(cols, rows uint16) error { return nil }
func (t *pipeTerminal) Size() (uint16, uint16, error)  { return 0, 0, nil }
func (t *pipeTerminal) ForegroundPGID() (int, bool)    { return 0, false }

func (t *pipeTerminal) PID() int {
	if t.cmd.Process == nil {
		return 0
	}
	return t.cmd.Process.Pid
}

func (t *pipeTerminal) Wait() error {
	t.waitOnce.Do(func() {
		<-t.stderrDone
		t.waitErr = t.cmd.Wait()
	})
	return t.waitErr
}

func (t *pipeTerminal) Terminate() error {
	if t.cmd.Process == nil {
		return nil
	}
	return Current().Process.Terminate(t.cmd.Process.Pid)
}

func (t *pipeTerminal) Kill() error {
	if t.cmd.Process == nil {
		return nil
	}
	return t.cmd.Process.Kill()
}
