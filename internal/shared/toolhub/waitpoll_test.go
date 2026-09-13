package toolhub

import (
	"strings"
	"testing"
	"time"
)

// 고정 대기(`time.Sleep`)의 대체 (M8 TEST-8). 비동기 정리·셸 기동이 얼마나
// 걸릴지는 기계가 정하고, 고정 값은 빠른 기계에서 낭비이고 느린 기계에서 거짓
// 실패다. `httpapi/shellready_test.go` 와 같은 뜻이다.

const (
	pollEvery      = 20 * time.Millisecond
	pollLimit      = 10 * time.Second
	shellQuietSpan = 150 * time.Millisecond
)

// waitFor 는 cond 가 설 때까지 되묻는다.
func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(pollLimit)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(pollEvery)
	}
	t.Fatalf("%s — %v 안에 서지 않았다", what, pollLimit)
}

// waitShellReady 는 셸이 **출력을 내고 조용해질** 때까지 기다린다 — 그 시점에
// 넣은 입력을 프롬프트가 먹는다. 바이트가 생겼는지만 보면 셸이 뜨기 전이다.
func waitShellReady(t *testing.T, p *Tool) {
	t.Helper()
	last, stableSince := -1, time.Now()
	waitFor(t, "셸 준비", func() bool {
		blob, _ := p.Stream().Snapshot()
		if n := len(blob); n != last {
			last, stableSince = n, time.Now()
			return false
		}
		return last > 0 && time.Since(stableSince) >= shellQuietSpan
	})
}

// waitOutput 은 스트림에 want 가 나타날 때까지 기다린다.
func waitOutput(t *testing.T, p *Tool, want string) {
	t.Helper()
	waitFor(t, "출력 "+want, func() bool {
		blob, _ := p.Stream().Snapshot()
		return strings.Contains(string(blob), want)
	})
}
