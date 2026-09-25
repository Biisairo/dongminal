package write

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/gittest"
	"dongminal/internal/webserver/domain/git/core"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-7-3 — 호출당 git 프로세스 수를 실제 프로세스로 센다
// (gittest.Count). 수와 함께 **무엇을** 띄웠는지도 본다.

func hasArg(call, arg string) bool {
	for _, f := range strings.Fields(call) {
		if f == arg {
			return true
		}
	}
	return false
}

// DOM-20: PushSpec 은 upstream·detached·브랜치만 쓴다 — 추적되지 않는 파일을 훑는
// 전체 status(`--untracked-files=all`) 대신 `--untracked-files=no` 로 묻는다.
func TestPushSpec_StatusSkipsUntracked(t *testing.T) {
	repo := tempRepoWithRemote(t)
	gitRun(t, repo, "push", "-q", "-u", "origin", "main")
	writeFile(t, repo, "u.txt", "untracked\n")
	c := gittest.Count(t)

	spec, _, err := PushSpec(core.New(), context.Background(), repo, PushOpts{})
	if err != nil {
		t.Fatalf("PushSpec: %v", err)
	}
	if fmt.Sprint(spec.Argv) != fmt.Sprint([]string{"push", progressFlag}) {
		t.Fatalf("argv = %v", spec.Argv)
	}
	calls := c.Calls()
	if len(calls) != 1 || !hasArg(calls[0], "status") || !hasArg(calls[0], "--untracked-files=no") {
		t.Fatalf("calls = %q, want status --untracked-files=no 한 번", calls)
	}

	// upstream 이 없으면 publish 계획을 세운다 — 브랜치 이름이 그대로 온다.
	gitRun(t, repo, "checkout", "-q", "-b", "side")
	c.Reset()
	_, plan, err := PushSpec(core.New(), context.Background(), repo, PushOpts{})
	if !errors.Is(err, ErrPublishRequired) || plan.Branch != "side" || plan.Remote != "origin" {
		t.Fatalf("publish plan = %+v, %v", plan, err)
	}
	if n := c.N(); n != 2 || !hasArg(c.Calls()[0], "--untracked-files=no") {
		t.Fatalf("calls = %q", c.Calls())
	}

	gitRun(t, repo, "checkout", "-q", "--detach")
	if _, _, err := PushSpec(core.New(), context.Background(), repo, PushOpts{}); !errors.Is(err, ErrDetachedPush) {
		t.Fatalf("detached = %v", err)
	}
}

// DOM-20: untracked 를 담지 않는 StashPush 는 추적 변경만 본다. 담을 것이 없을
// 때만 사유 문장(추적되지 않는 파일 수)을 위해 전체 status 를 한 번 더 묻는다.
func TestStashPush_StatusSkipsUntracked(t *testing.T) {
	repo := tempRepo(t)
	writeFile(t, repo, "README.md", "changed\n")
	writeFile(t, repo, "u.txt", "untracked\n")
	c := gittest.Count(t)

	if _, err := StashPush(core.New(), context.Background(), repo, StashPushOpts{}); err != nil {
		t.Fatalf("StashPush: %v", err)
	}
	calls := c.Calls()
	if len(calls) != 2 || !hasArg(calls[0], "--untracked-files=no") || !hasArg(calls[1], "stash") {
		t.Fatalf("calls = %q, want status -uno + stash push", calls)
	}

	// 이제 untracked 만 남았다 — 거부하고 사유는 종전과 같다.
	c.Reset()
	_, err := StashPush(core.New(), context.Background(), repo, StashPushOpts{})
	if !errors.Is(err, ErrStashEmpty) || !strings.Contains(err.Error(), "추적되지 않는 파일 1개뿐이다") {
		t.Fatalf("거부 = %v", err)
	}
	for _, call := range c.Calls() {
		if hasArg(call, "stash") {
			t.Fatalf("거부했는데 stash 를 실행했다: %q", c.Calls())
		}
	}

	// untracked 를 담으면 전체 status 한 번이다 (종전과 같다).
	c.Reset()
	if _, err := StashPush(core.New(), context.Background(), repo, StashPushOpts{IncludeUntracked: true}); err != nil {
		t.Fatalf("StashPush -u: %v", err)
	}
	calls = c.Calls()
	if len(calls) != 2 || !hasArg(calls[0], "--untracked-files=all") {
		t.Fatalf("calls = %q", calls)
	}
}

// DOM-21: StashPopChecked 는 stash list 를 두 번 부른다 (이전 3회 — 찾은 결과를
// 버리고 StashPop 이 다시 찾았다). 전체 git 은 list·pop·list 세 번이다.
func TestStashPopChecked_ThreeProcesses(t *testing.T) {
	repo := tempRepoWithStashes(t)
	s := core.New()
	list, err := StashList(s, context.Background(), repo)
	if err != nil || len(list) != 2 {
		t.Fatalf("StashList: %v %v", list, err)
	}
	c := gittest.Count(t)
	_, kept, err := StashPopChecked(s, context.Background(), repo, list[0].Oid, false)
	if err != nil || kept.Kept {
		t.Fatalf("pop: kept=%+v err=%v", kept, err)
	}
	if n := c.N(); n != 3 {
		t.Fatalf("git %d 회 (%q), want 3", n, c.Calls())
	}
}

// conflictRepoN 은 n 개의 양쪽 수정 충돌(UU)과 theirs 가 지운 f(UD)를 만든다.
func conflictRepoN(t *testing.T, n int) (string, Paths) {
	t.Helper()
	repo := tempRepo(t)
	gitRun(t, repo, "config", "core.autocrlf", "false")
	paths := Paths{"f"}
	for i := 0; i < n; i++ {
		paths = append(paths, fmt.Sprintf("g%d", i))
	}
	for _, p := range paths {
		writeFile(t, repo, p, "base\n")
	}
	gitRun(t, repo, append([]string{"add"}, paths...)...)
	gitRun(t, repo, "commit", "-q", "-m", "base")
	gitRun(t, repo, "checkout", "-q", "-b", "del")
	gitRun(t, repo, "rm", "-q", "f")
	for _, p := range paths[1:] {
		writeFile(t, repo, p, "theirs\n")
	}
	gitRun(t, repo, "commit", "-q", "-am", "theirs")
	gitRun(t, repo, "checkout", "-q", "main")
	for _, p := range paths {
		writeFile(t, repo, p, "ours\n")
	}
	gitRun(t, repo, "commit", "-q", "-am", "ours")
	cmd := exec.Command("git", "merge", "-q", "del")
	cmd.Dir = repo
	_ = cmd.Run() // 충돌로 exit 1
	return repo, paths
}

// DOM-22: 충돌 Resolve 는 경로를 묶어 실행한다 — checkout 묶음·add 묶음·rm 묶음.
// 이전에는 경로마다 2개(N 경로 → 2N)였다.
func TestResolve_BatchesPaths(t *testing.T) {
	repo, paths := conflictRepoN(t, 3)
	c := gittest.Count(t)

	res, err := Resolve(core.New(), context.Background(), repo, ResolveTheirs, paths)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	for i, r := range res {
		if r.Path != paths[i] || !r.OK {
			t.Fatalf("결과[%d] = %+v", i, r)
		}
	}
	// ls-files -u + checkout 묶음 + add 묶음 + rm 묶음 (이전: 1 + 3×2 + 1 = 8).
	if n := c.N(); n != 4 {
		t.Fatalf("git %d 회 (%q), want 4", n, c.Calls())
	}
	if _, err := os.Stat(filepath.Join(repo, "f")); !os.IsNotExist(err) {
		t.Fatal("theirs 가 지운 f 가 남아 있다")
	}
	for _, p := range paths[1:] {
		if b, _ := os.ReadFile(filepath.Join(repo, p)); string(b) != "theirs\n" {
			t.Fatalf("%s = %q", p, b)
		}
	}
	if out := gittest.Run(t, repo, "ls-files", "-u"); out != "" {
		t.Fatalf("충돌이 남았다: %q", out)
	}
}

// 묶음이 경로 하나 때문에 실패하면 그 묶음만 경로별로 다시 실행해 결과를 경로별로
// 유지한다 — 한 경로의 실패가 다른 경로를 막지 않는다 (REPO_FIX 01 §7.4).
func TestResolve_BatchFailureFallsBackPerPath(t *testing.T) {
	repo, paths := conflictRepoN(t, 2)
	req := Paths{paths[1], "nope", paths[2]}
	res, err := Resolve(core.New(), context.Background(), repo, ResolveOurs, req)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(res) != 3 || !res[0].OK || res[1].OK || res[1].Error == "" || !res[2].OK {
		t.Fatalf("결과 = %+v", res)
	}
	for _, p := range []string{paths[1], paths[2]} {
		if b, _ := os.ReadFile(filepath.Join(repo, p)); string(b) != "ours\n" {
			t.Fatalf("%s = %q", p, b)
		}
	}
	if out := gittest.Run(t, repo, "ls-files", "-u", "--", paths[1], paths[2]); out != "" {
		t.Fatalf("충돌이 남았다: %q", out)
	}
}
