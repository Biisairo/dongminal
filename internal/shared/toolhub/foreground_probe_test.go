package toolhub

import (
	"os"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
)

// startProbeShell은 실제 PTY 위에 셸을 띄운다. 전경 조회는 커널의 PTY 상태를
// 읽는 것이라 가짜로는 검증되지 않는다 — 여기만 실물을 쓴다.
func startProbeShell(t *testing.T) *Tool {
	t.Helper()
	t.Setenv("SHELL", "/bin/sh")
	p, err := StartTool("fg-probe", "Shell", t.TempDir(), 80, 24, func(string) {}, nil)
	if err != nil {
		t.Skipf("PTY 를 띄울 수 없는 환경: %v", err)
	}
	t.Cleanup(p.kill)
	return p
}

// waitForName은 전경 이름이 want 가 될 때까지 기다린다. 셸이 명령을 fork 하고
// 전경 그룹을 넘기기까지는 시간이 걸리므로 폴링한다.
func waitForName(t *testing.T, p *Tool, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		last = foregroundName(p.term, p.CmdProcessPID())
		if last == want {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("전경 이름=%q — %q 가 되어야 한다", last, want)
}

// TestForegroundNameLifecycle은 실제 PTY 에서 이름이 붙고 다시 사라지는 것을
// 고정한다 (V-TAN-1·2·3). 이름은 현재 상태의 표시이지 이력이 아니다 (FR-TAN-12).
func TestForegroundNameLifecycle(t *testing.T) {
	p := startProbeShell(t)

	// V-TAN-3: 프롬프트 대기 상태 — 전경 pgid 가 셸 자신의 것이다 (FR-TAN-6).
	waitForName(t, p, "")

	// V-TAN-1: 전경 프로그램이 뜨면 그 이름이 나온다.
	if err := p.Write([]byte("sleep 30\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	waitForName(t, p, "sleep")

	// V-TAN-2: 끝나면 이름이 사라진다.
	if err := p.Write([]byte{0x03}); err != nil {
		t.Fatalf("write ctrl-c: %v", err)
	}
	waitForName(t, p, "")
}

// TestForegroundNamePipeline은 파이프라인에서 이름이 나오고 오류가 없음을
// 고정한다 (V-TAN-10). 전경 그룹의 리더는 파이프라인의 첫 명령이다.
func TestForegroundNamePipeline(t *testing.T) {
	p := startProbeShell(t)
	waitForName(t, p, "")
	if err := p.Write([]byte("sleep 30 | cat\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	waitForName(t, p, "sleep")
}

// TestForegroundNameUnavailable은 조회 실패가 조용히 이름 없음이 되는 것을
// 고정한다 (FR-TAN-5, V-TAN-17). PTY 가 아닌 fd·닫힌 fd·없는 pid 어느 쪽도
// 오류가 되지 않는다.
func TestForegroundNameUnavailable(t *testing.T) {
	if got := foregroundName(nil, 1); got != "" {
		t.Errorf("터미널 없음 → %q", got)
	}

	p := startProbeShell(t)
	if got := foregroundName(p.term, 0); got != "" {
		t.Errorf("shellPid=0 → %q", got)
	}
	p.term.Close()
	if got := foregroundName(p.term, p.CmdProcessPID()); got != "" {
		t.Errorf("닫힌 터미널 → %q", got)
	}
}

// TestProcNamesBatch는 이름 읽기가 여러 pid 를 한 번에 다루는 것을 고정한다
// (NFR-CNV-1, NFR-XP-4). 구현은 platform.ProcInfo 로 옮겼지만, 이 도구가
// 기대하는 계약은 그대로여야 하므로 검사는 여기 남는다.
func TestProcNamesBatch(t *testing.T) {
	self := os.Getpid()
	names := platform.Current().Info.Names
	got := names([]int{self, 1, self, -1, 0})
	if got[self] == "" {
		t.Fatalf("자기 pid 의 이름을 못 읽었다: %v", got)
	}
	if got[1] == "" {
		t.Fatalf("pid 1 의 이름을 못 읽었다 — 일괄 조회가 아니면 이 조합이 깨진다: %v", got)
	}
	if _, ok := got[-1]; ok {
		t.Fatalf("잘못된 pid 가 결과에 들어갔다: %v", got)
	}
	if n := len(names([]int{999999999})); n != 0 {
		t.Fatalf("없는 pid 에 %d건 — 추측하면 안 된다", n)
	}
}
