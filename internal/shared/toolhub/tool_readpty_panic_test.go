package toolhub

import (
	"testing"
	"time"

	"dongminal/internal/shared/platform"
)

// M8 `GO-7`: readPTY 가 패닉해도 도구는 반죽음으로 남지 않는다.
//
// 종전에는 recover 가 로그만 남기고 돌아갔다 — PTY 와 프로세스가 남고, 종료 통보가
// 나가지 않아 클라이언트가 재연결을 되풀이하고(무한 재연결의 조건), tools.json 에 계속
// 기재됐다. 패닉 뒤에는 EOF 경로와 같은 순서 — kill() 그리고 onExit — 가 돈다.
func TestTool_ReadPTYPanic_KillsAndSignalsExit(t *testing.T) {
	exited := make(chan string, 1)
	p, err := StartTool("t-panic", "panic", t.TempDir(), 80, 24, func(id string) { exited <- id }, nil, nil, nil)
	if err != nil {
		t.Fatalf("StartTool: %v", err)
	}
	t.Cleanup(p.kill)

	// 패닉 주입 — 릴레이의 onOutput 은 readPTY 고루틴 안에서 불린다. 종료 통보는 릴레이의
	// onExit 하나다(데몬은 그것을 exit push 로 잇는다).
	p.WireRelayOnce(func(prevExit func(string)) (func(string, []byte, int64), func(string)) {
		return func(string, []byte, int64) { panic("injected readPTY panic") }, prevExit
	})
	if err := p.Write([]byte("echo panic-probe\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	select {
	case <-p.Wait():
	case <-time.After(5 * time.Second):
		t.Fatal("패닉 뒤 kill() 이 돌지 않았다 — done 이 닫히지 않았다")
	}
	select {
	case id := <-exited:
		if id != "t-panic" {
			t.Fatalf("onExit id=%q", id)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("패닉 뒤 onExit 이 불리지 않았다")
	}
	if pid := p.CmdProcessPID(); pid > 0 && platform.Current().Process.Alive(pid) {
		t.Fatalf("패닉 뒤에도 프로세스 %d 가 살아 있다", pid)
	}
}
