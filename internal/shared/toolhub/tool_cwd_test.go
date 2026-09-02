package toolhub

import (
	"os"
	"testing"
)

// 묶음 — 도구 cwd 의 **폴백 표면** (EXPLORER_TRANSFER_IGNORE_SRS FR-ETR-31).
//
// `ToolHub.Cwd` 의 계약은 "empty if unknown" 이다 (hub.go). 그런데 Tool.Cwd 가
// 조회 실패를 서버 프로세스의 cwd 로 덮어 왔고, 그 값이 `source:"tool"` 을 달고
// 나가 `+ Add` 의 자동채움에 **남의 경로**로 앉았다 (§2.4 의 실측).
//
// 폴백을 없애지 않는다 — 영속과 백그라운드 목록은 그것을 딛고 있다. 자리를
// 옮길 뿐이다: 조회는 정직하게 실패하고, 폴백이 필요한 자리가 스스로 부른다.

// Tool.Cwd 는 조회할 수 없으면 빈 값이다. pid 가 없는 도구(PTY 없는 합성 Tool,
// 또는 CWD 를 제공하지 않는 Windows)가 그 처지다.
func TestToolCwd_EmptyWhenUnresolvable(t *testing.T) {
	p := NewDetachedTool("t1", nil)
	if got := p.Cwd(); got != "" {
		t.Fatalf("Cwd() = %q, want %q — 서버의 cwd 가 도구의 것으로 나간다", got, "")
	}
}

// ToolManager.Cwd 도 같은 계약이다 — 모르는 도구든, 아는 도구의 조회 실패든
// 빈 값이며, 판단은 호출자가 한다.
func TestManagerCwd_EmptyWhenUnresolvable(t *testing.T) {
	m := NewToolManager(t.TempDir(), nil)
	if got := m.Cwd("nope"); got != "" {
		t.Fatalf("Cwd(unknown) = %q, want %q", got, "")
	}
}

// 폴백이 필요한 자리는 이것을 부른다. 종전 Tool.Cwd 의 동작이 그대로 여기 있다.
func TestCwdOrServer_FallsBackToServer(t *testing.T) {
	want, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	p := NewDetachedTool("t1", nil)
	if got := cwdOrServer(p); got != want {
		t.Fatalf("cwdOrServer() = %q, want %q — 영속이 딛는 폴백이 사라졌다", got, want)
	}
}
