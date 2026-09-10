package worktree

import (
	"os/exec"
	"strings"
	"testing"
)

// V3 (GIT_EXEC_UNIFY_SRS FR-GXU-2): 환경 규약이 **실제 프로세스에** 걸린다.
//
// 정적 게이트(FR-GXU-14)는 파일에 `Env()` 라는 글자가 있는지만 본다. 그것으로는
// "정말로 걸렸는가" 를 말할 수 없다 — 이 패키지는 종전에 그 규약이 통째로 빠진
// 채로 돌았고, 아무 검사도 그것을 보지 못했다.
//
// `git var` 를 쓰는 이유는 그것이 **git 자신이 읽은 환경**을 답하기 때문이다.
// 우리가 건 값이 아니라 git 이 쓸 값을 확인한다.
//
// 두 축만 보는 것으로 충분하다 — `core.Env()` 는 한 덩어리이므로 이것이 걸렸다면
// 프롬프트 배제(`GIT_TERMINAL_PROMPT=0`)와 잠금 회피(`GIT_OPTIONAL_LOCKS=0`)도
// 함께 걸렸다. 축마다 다른 집합을 주지 않는 것이 §5 N3 의 요구다.
func TestRunGitAppliesEnvContract(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git 이 없다 — 이 테스트를 건너뛴다")
	}
	dir := t.TempDir()

	// 호출자 환경이 반대 값을 갖고 있어도 규약이 이겨야 한다 — Env() 는
	// os.Environ() 뒤에 붙으므로 뒤가 이긴다.
	t.Setenv("GIT_EDITOR", "vim")
	t.Setenv("GIT_PAGER", "less")

	for _, tc := range []struct{ name, want string }{
		// 편집기를 기다리며 매달리지 않게 한다 (FR-GIT-252 의 --continue 경로).
		{"GIT_EDITOR", "true"},
		// 페이저는 출력을 붙잡는다.
		{"GIT_PAGER", "cat"},
	} {
		got, err := execGit(dir, "var", tc.name)
		if err != nil {
			t.Fatalf("execGit var %s: %v", tc.name, err)
		}
		if got != tc.want {
			t.Fatalf("%s 가 %q 다 (기대 %q) — core.Env() 가 걸리지 않았다", tc.name, got, tc.want)
		}
	}
}

// V9 (GIT_EXEC_UNIFY_SRS FR-GXU-8): 실패의 진단이 반환 문자열에 살아 있다.
//
// 종전에는 `CombinedOutput` 이 두 스트림을 시간순으로 섞어 돌려줬다. 지금은
// 스트림별로 모아 잇는다 — **stderr 를 잃으면 "왜 실패했는가" 가 통째로
// 사라지고**, 그 문자열이 `Residue.Detail` 로 화면에 간다.
func TestRunGitKeepsStderrOnFailure(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git 이 없다 — 이 테스트를 건너뛴다")
	}
	// 저장소가 아닌 곳에서 status 를 물으면 git 이 stderr 로 사유를 낸다.
	text, err := execGit(t.TempDir(), "status", "--porcelain")
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
