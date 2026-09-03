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
	}, nil, nil)
	if err != nil {
		t.Fatalf("toolhub.StartTool: %v", err)
	}

	// **셸이 입을 열 때까지 기다린 뒤에 쓴다** (FR-WTP-31 계열).
	//
	// 고정 대기나 즉시 쓰기로는 pwsh 를 맞출 수 없다 — 기동에 초 단위가 걸리고,
	// 준비되기 전에 넣은 입력은 프롬프트가 먹지 못한다. POSIX 의 sh 는 빨라서
	// 즉시 써도 우연히 통했을 뿐이다. 같은 함정을 doctor 가 먼저 밟았다
	// (CROSS_PLATFORM_SRS §11, a36417a).
	waitForShellReady(t, func() int { blob, _ := p.Stream().Snapshot(); return len(blob) })

	// 줄 끝은 **CR** 이다. 터미널의 Enter 가 보내는 것이 그것이고, ConPTY 는
	// LF 를 Enter 로 보지 않는다 — POSIX 의 pty 는 ICRNL 로 둘 다 받아 줘서
	// `\n` 이 우연히 통했을 뿐이다. doctor 도 같은 이유로 \r 을 쓴다.
	if err := p.Write([]byte("exit\r")); err != nil {
		t.Fatalf("write exit: %v", err)
	}

	select {
	case <-p.Wait():
	case <-time.After(shellReadyLimit):
		t.Fatalf("Wait() 채널이 %v 안에 닫히지 않았다", shellReadyLimit)
	}

	select {
	case id := <-called:
		if id != "t1" {
			t.Fatalf("onExit id=%q want t1", id)
		}
	case <-time.After(shellReadyLimit):
		t.Fatalf("onExit 콜백이 %v 안에 불리지 않았다", shellReadyLimit)
	}
}
