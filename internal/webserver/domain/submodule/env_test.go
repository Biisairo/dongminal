package submodule

import (
	"os/exec"
	"strings"
	"testing"
)

// V3 (GIT_EXEC_UNIFY_SRS FR-GXU-2): 환경 규약이 **실제 프로세스에** 걸린다.
//
// **이 패키지가 그 규약이 가장 필요한 자리다.** `submodule update --init` 은
// 원격에 닿으므로, `GIT_TERMINAL_PROMPT=0` 이 없으면 private 서브모듈에서
// 자격증명 프롬프트가 뜨고 프로세스가 opTimeout(180초)까지 매달린다 — GUI
// askpass 면 보이지 않는 창을 기다린다. 종전에는 그 규약이 빠져 있었다.
//
// `git var` 는 git 자신이 읽은 환경을 답한다. `core.Env()` 는 한 덩어리이므로
// 이것이 걸렸다면 프롬프트·askpass 배제도 함께 걸렸다.
func TestRunGitAppliesEnvContract(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git 이 없다 — 이 테스트를 건너뛴다")
	}
	dir := t.TempDir()

	t.Setenv("GIT_EDITOR", "vim")
	t.Setenv("GIT_PAGER", "less")

	for _, tc := range []struct{ name, want string }{
		{"GIT_EDITOR", "true"},
		{"GIT_PAGER", "cat"},
	} {
		got, err := ExecGit(dir, "var", tc.name)
		if err != nil {
			t.Fatalf("ExecGit var %s: %v", tc.name, err)
		}
		if got != tc.want {
			t.Fatalf("%s 가 %q 다 (기대 %q) — core.Env() 가 걸리지 않았다", tc.name, got, tc.want)
		}
	}
}

// V9 (GIT_EXEC_UNIFY_SRS FR-GXU-8): 실패의 진단이 반환 문자열에 살아 있다.
//
// 이 패키지에서 특히 중요하다 — `runPathOp` 이 그 문자열을 `tail()` 에 넘기고,
// `diagtail.Of` 는 **출력이 비어 있을 때만** 오류 문구를 쓴다. stderr 가 결합에서
// 빠지면 사용자가 받는 사유가 통째로 달라진다.
func TestRunGitKeepsStderrOnFailure(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git 이 없다 — 이 테스트를 건너뛴다")
	}
	text, err := ExecGit(t.TempDir(), "submodule", "status")
	if err == nil {
		t.Fatal("저장소가 아닌 곳에서 성공했다")
	}
	if text == "" {
		t.Fatal("진단이 비었다 — stderr 가 결합에서 빠졌다")
	}
	if !strings.Contains(text, "not a git repository") {
		t.Fatalf("stderr 의 사유가 없다: %q", text)
	}
}
