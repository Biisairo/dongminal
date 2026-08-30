package httpapi

import (
	"testing"
	"time"
)

// 셸이 준비됐는지 재는 값들 — **한 곳에만 둔다.**
//
// 이 숫자들은 취향이 아니라 실측으로 고른 것이다(CI 플레이크를 잡으려고 골랐다).
// 두 벌로 두면 한쪽만 조정되고 나머지가 조용히 옛 값으로 남는다.
const (
	// shellQuiet 은 "출력이 멎었다" 로 볼 정지 시간이다.
	shellQuiet = 700 * time.Millisecond
	// shellPoll 은 되묻는 간격이다.
	shellPoll = 25 * time.Millisecond
	// shellReadyLimit 은 준비를 기다리는 상한이다. pwsh 는 PSReadLine 을
	// 올리는 데 초 단위가 걸린다.
	shellReadyLimit = 20 * time.Second
)

// waitForShellReady 는 셸이 **준비될 때까지** 기다린다.
//
// 바이트가 생겼는지만 보면 안 된다 — ConPTY 는 세션을 열며 인사말 16바이트
// (`\x1b[?9001h\x1b[?1004h`)를 즉시 내보내고, 그것은 셸이 뜨기 전이다. 그
// 시점에 넣은 입력은 프롬프트가 먹지 못하고 사라진다. 고정 대기도 같은 이유로
// 못 맞춘다.
//
// 그래서 doctor 와 같은 신호를 쓴다 (CROSS_PLATFORM_SRS §11, a36417a):
// **출력이 오고 조용해지는 것.**
//
// size 는 지금까지 쌓인 출력의 길이를 준다. 그것만 다르고 나머지는 같으므로
// 직접 모드와 데몬 모드가 이 함수를 공유한다.
func waitForShellReady(t *testing.T, size func() int) {
	t.Helper()
	deadline := time.Now().Add(shellReadyLimit)
	last := -1
	stableSince := time.Now()
	for time.Now().Before(deadline) {
		if n := size(); n != last {
			last, stableSince = n, time.Now()
		} else if last > 0 && time.Since(stableSince) >= shellQuiet {
			return
		}
		time.Sleep(shellPoll)
	}
	if last > 0 {
		return // 조용해지지는 않았지만 살아는 있다 — 더 기다리지 않는다
	}
	t.Fatalf("셸이 %v 안에 아무것도 내보내지 않았다", shellReadyLimit)
}
