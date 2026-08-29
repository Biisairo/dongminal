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

// waitForToolOutput 은 셸이 **준비될 때까지** 기다린다.
//
// 바이트가 생겼는지만 보면 안 된다 — ConPTY 는 세션을 열며 인사말 16바이트
// (`\x1b[?9001h\x1b[?1004h`)를 즉시 내보내고, 그것은 셸이 뜨기 전이다.
// 그 시점에 넣은 입력은 프롬프트가 먹지 못하고 사라진다.
//
// 그래서 doctor 와 같은 신호를 쓴다 (CROSS_PLATFORM_SRS §11, a36417a):
// **출력이 오고 조용해지는 것.** pwsh 는 PSReadLine 을 올리는 데 초 단위가
// 걸리므로 고정 대기로는 맞출 수 없다.
func waitForToolOutput(t *testing.T, p *toolhub.Tool, limit time.Duration) {
	t.Helper()
	const quiet = 700 * time.Millisecond
	deadline := time.Now().Add(limit)
	var last int
	stableSince := time.Now()
	for time.Now().Before(deadline) {
		blob, _ := p.Stream().Snapshot()
		if n := len(blob); n != last {
			last, stableSince = n, time.Now()
		} else if last > 0 && time.Since(stableSince) >= quiet {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	if last > 0 {
		return // 조용해지지 않았지만 살아는 있다 — 더 기다리지 않는다
	}
	t.Fatalf("셸이 %v 안에 아무것도 내보내지 않았다", limit)
}
