package httpapi

import (
	"dongminal/internal/shared/toolhub"

	"testing"
	"time"
)

func TestToolOnExitAndWait(t *testing.T) {
	called := make(chan string, 1)
	p, err := toolhub.StartTool("t1", "test", "", 80, 24, func(id string) {
		called <- id
	}, nil)
	if err != nil {
		t.Fatalf("toolhub.StartTool: %v", err)
	}

	// **셸이 입을 열 때까지 기다린 뒤에 쓴다** (FR-WTP-31 계열).
	//
	// 고정 대기나 즉시 쓰기로는 pwsh 를 맞출 수 없다 — 기동에 초 단위가 걸리고,
	// 준비되기 전에 넣은 입력은 프롬프트가 먹지 못한다. POSIX 의 sh 는 빨라서
	// 즉시 써도 우연히 통했을 뿐이다. 같은 함정을 doctor 가 먼저 밟았다
	// (CROSS_PLATFORM_SRS §11, a36417a).
	waitForToolOutput(t, p, 20*time.Second)

	// 줄 끝은 **CR** 이다. 터미널의 Enter 가 보내는 것이 그것이고, ConPTY 는
	// LF 를 Enter 로 보지 않는다 — POSIX 의 pty 는 ICRNL 로 둘 다 받아 줘서
	// `\n` 이 우연히 통했을 뿐이다. doctor 도 같은 이유로 \r 을 쓴다.
	if err := p.Write([]byte("exit\r")); err != nil {
		t.Fatalf("write exit: %v", err)
	}

	select {
	case <-p.Wait():
	case <-time.After(20 * time.Second):
		t.Fatal("Wait() channel did not close within 20s")
	}

	select {
	case id := <-called:
		if id != "t1" {
			t.Fatalf("onExit id=%q want t1", id)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("onExit callback not invoked within 20s")
	}
}

// waitForToolOutput 은 셸이 무엇이든 내보낼 때까지 기다린다. 무엇이 나오는지는
// 셸마다 다르므로(프롬프트·배너·ConPTY 인사말) 내용을 보지 않고 **바이트가
// 생겼는지만** 본다.
func waitForToolOutput(t *testing.T, p *toolhub.Tool, limit time.Duration) {
	t.Helper()
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		if blob, _ := p.Stream().Snapshot(); len(blob) > 0 {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("셸이 %v 안에 아무것도 내보내지 않았다", limit)
}
