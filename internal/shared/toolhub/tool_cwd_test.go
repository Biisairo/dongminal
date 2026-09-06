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

// ── WINDOWS_TOOL_CWD_SRS — 셸 훅의 보고를 서버가 듣는다 ──

const oscCwd = "\x1b]777;Cwd;"

// V-WTC-1: 종단자는 BEL 과 ST 둘 다다. 다른 OSC 와 섞여 있어도 골라낸다.
func TestDetectCwdReport_Terminators(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"BEL", oscCwd + "/a/b\x07", "/a/b"},
		{"ST", oscCwd + "/a/b\x1b\\", "/a/b"},
		{"윈도우 경로", oscCwd + `C:\Users\x\repo` + "\x07", `C:\Users\x\repo`},
		{"앞뒤에 글자", "prompt$ " + oscCwd + "/a\x07 tail", "/a"},
		{"다른 OSC 와 섞임", "\x1b]0;title\x07" + oscCwd + "/a\x07", "/a"},
		{"보고 없음", "\x1b]0;title\x07plain", ""},
		{"끝나지 않은 OSC", oscCwd + "/a", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := DetectCwdReport([]byte(c.in)); got != c.want {
				t.Fatalf("DetectCwdReport(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

// V-WTC-1 (D-5): 한 청크에 프롬프트가 여럿이면 **마지막**이 지금의 자리다.
func TestDetectCwdReport_LastWins(t *testing.T) {
	in := oscCwd + "/first\x07out" + oscCwd + "/second\x07"
	if got := DetectCwdReport([]byte(in)); got != "/second" {
		t.Fatalf("DetectCwdReport = %q, want %q", got, "/second")
	}
}

// FR-WTC-5: 빈 보고는 아는 것을 덮지 않는다.
func TestToolCwd_EmptyReportDoesNotClobber(t *testing.T) {
	p := NewDetachedTool("t1", nil)
	p.observeOutput([]byte(oscCwd + "/known\x07"))
	p.observeOutput([]byte(oscCwd + "\x07"))
	if got := p.Cwd(); got != "/known" {
		t.Fatalf("Cwd() = %q, want %q — 빈 보고가 아는 값을 덮었다", got, "/known")
	}
}

// V-WTC-3: 직접 조회가 안 되는 처지(합성 Tool = pid 없음)에서는 보고가 답이다.
// 이것이 Windows 의 처지 그대로다 — `windowsProcInfo.CWD` 는 언제나 거짓이다.
func TestToolCwd_UsesHookReportWhenProbeFails(t *testing.T) {
	p := NewDetachedTool("t1", nil)
	if got := p.Cwd(); got != "" {
		t.Fatalf("보고 전 Cwd() = %q, want %q", got, "")
	}
	p.observeOutput([]byte("PS C:\\> " + oscCwd + `C:\Users\x\repo` + "\x07"))
	if got, want := p.Cwd(), `C:\Users\x\repo`; got != want {
		t.Fatalf("Cwd() = %q, want %q — 훅 보고가 서버에 닿지 않는다", got, want)
	}
}

// FR-WTC-2 (D-4): 알람 배선이 없는 도구도 자기 자리는 말한다. 종전 관측 경로는
// `onAttention == nil` 이면 곧바로 돌아갔다.
func TestToolCwd_ReportedWithoutAttentionWiring(t *testing.T) {
	p := NewDetachedTool("t1", nil) // hooks 가 nil 이므로 onAttention 도 nil 이다
	if p.onAttention != nil {
		t.Fatal("전제가 깨졌다 — 이 도구에는 알람 배선이 없어야 한다")
	}
	p.observeOutput([]byte(oscCwd + "/reported\x07"))
	if got := p.Cwd(); got != "/reported" {
		t.Fatalf("Cwd() = %q, want %q", got, "/reported")
	}
}

// FR-WTC-3: 보고가 있어도 **폴백의 계약은 그대로다** — 보고가 있으면 그것이
// 도구의 값이므로 서버의 cwd 로 떨어지지 않는다.
func TestCwdOrServer_PrefersReport(t *testing.T) {
	p := NewDetachedTool("t1", nil)
	p.observeOutput([]byte(oscCwd + "/reported\x07"))
	if got := cwdOrServer(p); got != "/reported" {
		t.Fatalf("cwdOrServer() = %q, want %q", got, "/reported")
	}
}

// V-WTC-6 (FR-WTC-6): 뜬 자리가 처음 값이다. 첫 프롬프트가 돌기 전까지 서버가
// 아는 사실은 그것 하나이며, 승계(`cwdTool=…`)가 그 값을 딛는다.
func TestToolCwd_SeededFromStartDir(t *testing.T) {
	dir := t.TempDir()
	p, err := StartTool("t-seed", "seed", dir, 80, 24, nil, nil, nil)
	if err != nil {
		t.Skipf("이 호스트에서 셸을 띄울 수 없다: %v", err)
	}
	defer p.kill()
	// 어떤 출력도 기다리지 않는다 — 지금 물어도 답이 있어야 한다.
	got := p.Cwd()
	if got == "" {
		t.Fatal("갓 뜬 도구가 자기 자리를 모른다 — 승계가 홈으로 떨어진다")
	}
	// 직접 조회가 되는 처지(POSIX)에서는 그쪽이 이기므로 심링크가 풀린 값일 수
	// 있다. 어느 쪽이든 **서버의 cwd 가 아니어야** 한다는 것이 요점이다.
	if srv, _ := os.Getwd(); got == srv {
		t.Fatalf("Cwd() = %q — 서버의 cwd 가 도구의 것으로 나간다", got)
	}
}
