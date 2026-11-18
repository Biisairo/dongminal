package agentadapter

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// RUN_RECOVERY_SRS TC-RRC-1: 재개줄은 Launch · 재개 인자 · (멤버면) MemberArgs 순이고,
// 셸에 갈 값은 전부 셸의 인용을 거친다.
func TestResumeLine_ClaudeMember(t *testing.T) {
	claude, _ := Get("claude")
	line, err := claude.resumeLine(&recordingShell{}, "", "abc-123", true)
	if err != nil {
		t.Fatal(err)
	}
	want := "claude «--resume» «abc-123» «--allowedTools» «Bash(dmctl:*)»"
	if line != want {
		t.Fatalf("line=%q want %q", line, want)
	}
}

func TestResumeLine_CoordinatorHasNoMemberArgs(t *testing.T) {
	claude, _ := Get("claude")
	line, err := claude.resumeLine(&recordingShell{}, "", "abc-123", false)
	if err != nil {
		t.Fatal(err)
	}
	if line != "claude «--resume» «abc-123»" {
		t.Fatalf("line=%q", line)
	}
}

func TestResumeLine_OmpFillsHooksDir(t *testing.T) {
	omp, _ := Get("omp")
	hooks := filepath.Join("h", "agent-hooks")
	line, err := omp.resumeLine(&recordingShell{}, hooks, "s1", true)
	if err != nil {
		t.Fatal(err)
	}
	want := "omp «--resume=s1» «--config» «" + filepath.Join(hooks, OmpMemberConfigFile) + "»"
	if line != want {
		t.Fatalf("line=%q want %q", line, want)
	}
	if _, err := omp.resumeLine(&recordingShell{}, "", "s1", true); err == nil {
		t.Fatal("hooksDir 없이 omp 멤버 재개줄이 만들어졌다")
	}
}

func TestResumeLine_CodexIsUnconfirmed(t *testing.T) {
	codex, _ := Get("codex")
	if codex.CanResume() {
		t.Fatal("codex 재개 방법은 미확인이다 (D-RRC-4)")
	}
	if _, err := codex.resumeLine(&recordingShell{}, "", "s1", true); !errors.Is(err, ErrNoResume) {
		t.Fatalf("err=%v want ErrNoResume", err)
	}
}

// TC-RRC-2: 세션 id 는 형식 검사를 통과한 것만 재개줄에 실린다.
func TestValidSessionID(t *testing.T) {
	ok := []string{"8f365211-937f-4591-8f20-2e03362d855e", "a", "A.b_c-9", strings.Repeat("x", 128)}
	bad := []string{"", "a;b", "$(rm)", "a b", "a'b", "a/b", strings.Repeat("x", 129), "가",
		// 옵션으로 읽히는 값 — 첫 글자는 영문·숫자여야 한다.
		"-x", "--dangerously-skip-permissions", ".a", "_a"}
	for _, s := range ok {
		if !ValidSessionID(s) {
			t.Errorf("%q: 받아야 한다", s)
		}
	}
	for _, s := range bad {
		if ValidSessionID(s) {
			t.Errorf("%q: 거절해야 한다", s)
		}
	}
	claude, _ := Get("claude")
	if _, err := claude.resumeLine(&recordingShell{}, "", "a;b", true); !errors.Is(err, ErrBadSession) {
		t.Fatalf("err=%v want ErrBadSession", err)
	}
}

// TC-RRC-15: claude 의 세션 등록부(`<설정 폴더>/sessions/<pid>.json`)에서 그 세션의 pid 를 모은다.
func TestClaudeSessionPIDs(t *testing.T) {
	claude, _ := Get("claude")
	if claude.SessionPIDs == nil {
		t.Fatal("claude 는 세션 등록부를 선언해야 한다 (FR-RRC-5)")
	}
	a, b := t.TempDir(), t.TempDir()
	write := func(dir, name, body string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(dir, "sessions"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "sessions", name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(a, "11.json", `{"pid":11,"sessionId":"S"}`)
	write(a, "12.json", `{"pid":12,"sessionId":"other"}`)
	write(a, "13.json", `{깨짐`)
	write(a, "11.abc.key", `{"pid":99,"sessionId":"S"}`)
	write(b, "21.json", `{"pid":21,"sessionId":"S"}`)
	missing := filepath.Join(t.TempDir(), "없음")

	pids, ok := claude.SessionPIDs("S", []string{a, b, missing})
	if !ok {
		t.Fatal("읽을 수 있는 폴더들인데 모름이 나왔다")
	}
	if !reflect.DeepEqual(pids, []int{11, 21}) {
		t.Fatalf("pids=%v want [11 21]", pids)
	}
	if pids, ok := claude.SessionPIDs("S", []string{missing}); !ok || len(pids) != 0 {
		t.Fatalf("폴더가 없으면 빈 목록이다: %v %v", pids, ok)
	}
	// sessions 가 폴더가 아니면 읽지 못한 것이다 — 모름.
	c := t.TempDir()
	if err := os.WriteFile(filepath.Join(c, "sessions"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := claude.SessionPIDs("S", []string{c}); ok {
		t.Fatal("읽지 못한 폴더는 모름이어야 한다")
	}
	omp, _ := Get("omp")
	if omp.SessionPIDs != nil {
		t.Fatal("omp 의 등록부는 확인하지 않았다")
	}
}
