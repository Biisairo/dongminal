package gitapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
	"dongminal/internal/webserver/domain/git/write"
	"dongminal/internal/webserver/domain/submodule"
	"dongminal/internal/webserver/domain/worktree"
)

// REPO_FIX 01 §5.6 — worktree add 는 잡(common 칸 + repoLock), remove 는 대상 worktree
// 의 칸·뮤텍스만 본다. 실제 git 을 쓴다(worktreeTestServer).

const wtExclWait = 80 * time.Millisecond

// wtExclServer 의 잡 실행기는 사용자 영역의 `worktree add` 만 실제 git 으로 돌리고
// 나머지(테스트가 칸을 채우려고 띄운 잡)는 테스트가 끝날 때까지 붙잡는다. 허브는
// 처음 쓸 때 실행기를 고정하므로 서버를 만들 때 넣어야 한다.
func wtExclServer(t *testing.T) (*GitServer, string, *worktree.Manager) {
	t.Helper()
	s, repo, mgr := worktreeTestServer(t)
	s.Exclusion = jobs.NewExclusion()
	s.lockWait = wtExclWait
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	hold := gitRemoteHold(release)
	s.gitJobs.run = func(ctx context.Context, dir string, args []string, stdin string, emit func(string, string)) (int, error) {
		if len(args) > 2 && args[0] == "worktree" && args[1] == "add" && strings.HasPrefix(args[len(args)-2], mgr.Root()) {
			out, err := submodule.ExecGit(ctx, dir, args...)
			if err != nil {
				emit(jobs.LineStderr, out)
				return 1, nil
			}
			return 0, nil
		}
		return hold(ctx, dir, args, stdin, emit)
	}
	return s, repo, mgr
}

func wtCommonKey(t *testing.T, repo string) string {
	t.Helper()
	k, err := core.New().CommonDirKey(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// wtCreate 는 생성 잡을 끝까지 기다려 결과를 준다.
func wtCreate(t *testing.T, s *GitServer, repo, name string, newBranch bool) *jobs.Job {
	t.Helper()
	body := fmt.Sprintf(`{"repo":%q,"name":%q,"ref":"main","newBranch":%v}`, repo, name, newBranch)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/create", body)
	if code != http.StatusOK || out["job"] == nil {
		t.Fatalf("create = %d %+v, want 200 {job}", code, out)
	}
	jb := gitJobDone(t, s, out)
	if !jobSucceeded(jb) || jb.Result == nil || jb.Result.Path == "" {
		t.Fatalf("생성 잡 실패: %+v (result %+v)", jb, jb.Result)
	}
	return jb
}

// 생성은 잡이다 — common 칸, 결과에 path·branch, 완료 처리가 config 두 건을 쓰고
// repoLock 을 반납한다.
func TestWorktreeCreate_IsACommonJob(t *testing.T) {
	s, repo, mgr := wtExclServer(t)
	body := fmt.Sprintf(`{"repo":%q,"name":"feat","ref":"main","newBranch":true}`, repo)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/create", body)
	if code != http.StatusOK {
		t.Fatalf("= %d %+v", code, out)
	}
	raw, _ := out["job"].(map[string]any)
	if raw["kind"] != "worktree" {
		t.Fatalf("kind = %v", raw["kind"])
	}
	if slots, _ := raw["slots"].([]any); len(slots) != 1 || slots[0] != jobs.SlotCommon {
		t.Fatalf("slots = %v, want [common]", raw["slots"])
	}
	jb := gitJobDone(t, s, out)
	if !jobSucceeded(jb) || jb.Result == nil {
		t.Fatalf("잡 = %+v", jb)
	}
	if !strings.HasPrefix(jb.Result.Path, mgr.Root()+string(filepath.Separator)) || jb.Result.Branch != "feat" {
		t.Fatalf("result = %+v", jb.Result)
	}
	if got := strings.TrimSpace(wtGitRun(t, jb.Result.Path, "config", "push.autoSetupRemote")); got != "true" {
		t.Fatalf("push.autoSetupRemote = %q", got)
	}
	if got := strings.TrimSpace(wtGitRun(t, repo, "config", "branch.feat.base")); got != "main" {
		t.Fatalf("branch.feat.base = %q", got)
	}
	release, err := worktree.LockRepo(context.Background(), wtCommonKey(t, repo), wtExclWait)
	if err != nil {
		t.Fatalf("완료 뒤 repoLock 이 남았다: %v", err)
	}
	release()
}

// 같은 common dir 의 common 칸이 차 있으면 409 job_busy — 아무것도 만들지 않는다.
func TestWorktreeCreate_CommonSlotBusy(t *testing.T) {
	s, repo, mgr := wtExclServer(t)
	keys := jobs.Keys{Top: core.ExclusionKey(repo), Common: wtCommonKey(t, repo)}
	if _, err := s.jobsHub().StartUnguarded(repo, keys, "submodule", []string{"submodule", "update"}, "test"); err != nil {
		t.Fatal(err)
	}
	body := fmt.Sprintf(`{"repo":%q,"name":"feat","ref":"main"}`, repo)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/create", body)
	if code != http.StatusConflict || out["error"] != gitErrJobBusy {
		t.Fatalf("= %d %+v, want 409 job_busy", code, out)
	}
	if _, err := os.Stat(mgr.Root()); !os.IsNotExist(err) {
		t.Fatalf("거부됐는데 디렉터리가 생겼다: %v", err)
	}
}

// repoLock 을 5s(여기서는 짧게) 안에 얻지 못하면 409 repo_busy.
func TestWorktreeCreate_RepoLockBusy(t *testing.T) {
	s, repo, _ := wtExclServer(t)
	release, err := worktree.LockRepo(context.Background(), wtCommonKey(t, repo), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	body := fmt.Sprintf(`{"repo":%q,"name":"feat","ref":"main"}`, repo)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/worktrees/create", body)
	if code != http.StatusConflict || out["error"] != apierr.CodeRepoBusy {
		t.Fatalf("= %d %+v, want 409 repo_busy", code, out)
	}
}

// 등록 직전에 요청이 떠나면 등록하지 않고, repoLock 을 반납하고, 이번에 만든 빈 부모
// 디렉터리를 지운다.
func TestWorktreeCreate_CanceledBeforeRegisterCleansUp(t *testing.T) {
	s, repo, _ := wtExclServer(t)
	home := filepath.Dir(s.UserWorktrees.Root())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// BranchExists(rev-parse --verify) 에서 요청이 떠난다 — 부모 디렉터리 생성 뒤의
	// ④ 확인에서 걸린다.
	mgr := worktree.New(filepath.Join(home, "git-worktrees"), worktree.WithRunner(
		func(c context.Context, dir string, args ...string) (string, error) {
			if len(args) > 1 && args[0] == "rev-parse" && args[1] == "--verify" {
				cancel()
			}
			return submodule.ExecGit(c, dir, args...)
		}))
	s.UserWorktrees = mgr
	body := fmt.Sprintf(`{"repo":%q,"name":"feat","ref":"main","newBranch":true}`, repo)
	r := httptest.NewRequest(http.MethodPost, "/api/git/worktrees/create", strings.NewReader(body)).WithContext(ctx)
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, r)
	if code, name := decodeFail(t, rec); code != apierr.StatusClientClosed || name != apierr.CodeCanceled {
		t.Fatalf("= %d %s, want 499 git_canceled", code, name)
	}
	if _, err := os.Stat(mgr.Root()); !os.IsNotExist(err) {
		t.Fatalf("이번에 만든 빈 부모 디렉터리가 남았다: %v", err)
	}
	release, err := worktree.LockRepo(context.Background(), wtCommonKey(t, repo), wtExclWait)
	if err != nil {
		t.Fatalf("등록 실패 뒤 repoLock 이 남았다: %v", err)
	}
	release()
}

func wtRemove(t *testing.T, s *GitServer, repo, path string) (int, map[string]any) {
	t.Helper()
	body := fmt.Sprintf(`{"repo":%q,"path":%q,"confirm":true}`, repo, path)
	return wtReq(t, s, http.MethodPost, "/api/git/worktrees/remove", body)
}

// worktree 잡이 도는 동안 remove 는 409 job_busy.
func TestWorktreeRemove_WorktreeJobBusy(t *testing.T) {
	s, repo, _ := wtExclServer(t)
	path := wtCreate(t, s, repo, "feat", true).Result.Path
	keys := jobs.Keys{Top: core.ExclusionKey(repo), Common: wtCommonKey(t, repo)}
	if _, err := s.jobsHub().StartUnguarded(repo, keys, "worktree", []string{"worktree", "add", "x"}, "test"); err != nil {
		t.Fatal(err)
	}
	if code, out := wtRemove(t, s, repo, path); code != http.StatusConflict || out["error"] != gitErrJobBusy {
		t.Fatalf("= %d %+v, want 409 job_busy", code, out)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("거부됐는데 지워졌다: %v", err)
	}
}

// 원격 잡(push·fetch)은 common 칸이지만 worktree 잡이 아니다 — remove 는 막히지 않는다.
func TestWorktreeRemove_RemoteJobDoesNotBlock(t *testing.T) {
	s, repo, _ := wtExclServer(t)
	path := wtCreate(t, s, repo, "feat", true).Result.Path
	keys := jobs.Keys{Top: core.ExclusionKey(repo), Common: wtCommonKey(t, repo)}
	if _, err := s.jobsHub().Start(repo, keys, "fetch", write.FetchSpec(write.FetchOpts{})); err != nil {
		t.Fatal(err)
	}
	if code, out := wtRemove(t, s, repo, path); code != http.StatusOK || out["removed"] != true {
		t.Fatalf("= %d %+v, want 200 removed", code, out)
	}
}

// 대상 worktree 의 index 칸이 차 있으면 409 job_busy, 요청 worktree 의 index 칸은
// 보지 않는다.
func TestWorktreeRemove_TargetIndexSlotOnly(t *testing.T) {
	s, repo, _ := wtExclServer(t)
	a := wtCreate(t, s, repo, "a", true).Result.Path
	b := wtCreate(t, s, repo, "b", true).Result.Path
	common := wtCommonKey(t, repo)
	commit := write.CommitSpec(write.CommitOpts{Message: "x"})
	if _, err := s.jobsHub().Start(a, jobs.Keys{Top: core.ExclusionKey(a), Common: common}, "commit", commit); err != nil {
		t.Fatal(err)
	}
	if _, err := s.jobsHub().Start(repo, jobs.Keys{Top: core.ExclusionKey(repo), Common: common}, "commit", commit); err != nil {
		t.Fatal(err)
	}
	if code, out := wtRemove(t, s, repo, a); code != http.StatusConflict || out["error"] != gitErrJobBusy {
		t.Fatalf("대상 index 잡 중 = %d %+v, want 409 job_busy", code, out)
	}
	if code, out := wtRemove(t, s, repo, b); code != http.StatusOK || out["removed"] != true {
		t.Fatalf("요청 worktree 의 index 잡 중 = %d %+v, want 200 removed", code, out)
	}
}

// 대상 toplevel 뮤텍스를 얻지 못하면 409 repo_busy. common-dir 잠금(stash)은 보지
// 않는다 — remove 는 stash 를 막지 않는다.
func TestWorktreeRemove_TargetMutexNotStashLock(t *testing.T) {
	s, repo, _ := wtExclServer(t)
	path := wtCreate(t, s, repo, "feat", true).Result.Path
	x := s.exclusion()
	relCommon, err := x.LockCommon(context.Background(), wtCommonKey(t, repo), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer relCommon()
	relTop, err := x.LockTop(context.Background(), core.ExclusionKey(path), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if code, out := wtRemove(t, s, repo, path); code != http.StatusConflict || out["error"] != apierr.CodeRepoBusy {
		t.Fatalf("대상 뮤텍스 중 = %d %+v, want 409 repo_busy", code, out)
	}
	relTop()
	if code, out := wtRemove(t, s, repo, path); code != http.StatusOK || out["removed"] != true {
		t.Fatalf("stash 잠금 중 = %d %+v, want 200 removed", code, out)
	}
}

// repoLock 대기가 쓰기 단계 마감에 걸리면 504 git_timeout — 삭제는 일어나지 않는다.
func TestWorktreeRemove_RepoLockDeadlineIs504(t *testing.T) {
	s, repo, _ := wtExclServer(t)
	path := wtCreate(t, s, repo, "feat", true).Result.Path
	release, err := worktree.LockRepo(context.Background(), wtCommonKey(t, repo), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	s.managerWrite = wtExclWait
	if code, out := wtRemove(t, s, repo, path); code != http.StatusGatewayTimeout || out["error"] != apierr.CodeTimeout {
		t.Fatalf("= %d %+v, want 504 git_timeout", code, out)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("시한에 걸렸는데 지워졌다: %v", err)
	}
}

// 요청 = 대상이면 Manager 가 unsafe-path 잔여물로 끝낸다.
func TestWorktreeRemove_SelfIsUnsafePath(t *testing.T) {
	s, repo, _ := wtExclServer(t)
	path := wtCreate(t, s, repo, "feat", true).Result.Path
	code, out := wtRemove(t, s, path, path)
	if code != http.StatusOK || out["removed"] != false || out["residue"] != worktree.ResidueUnsafePath {
		t.Fatalf("= %d %+v, want 200 unsafe-path", code, out)
	}
}

// 밖에서 지운 worktree 도 순서가 그대로 돌고 제거(prune)에 성공한다. 연달아 지워도
// 차례로 성공한다.
func TestWorktreeRemove_GoneOutsideAndConsecutive(t *testing.T) {
	s, repo, _ := wtExclServer(t)
	a := wtCreate(t, s, repo, "a", true).Result.Path
	b := wtCreate(t, s, repo, "b", true).Result.Path
	if err := os.RemoveAll(a); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make([]map[string]any, 2)
	codes := make([]int, 2)
	for i, p := range []string{a, b} {
		wg.Add(1)
		go func(i int, p string) {
			defer wg.Done()
			codes[i], results[i] = wtRemove(t, s, repo, p)
		}(i, p)
	}
	wg.Wait()
	for i := range results {
		if codes[i] != http.StatusOK || results[i]["removed"] != true {
			t.Fatalf("[%d] = %d %+v, want 200 removed", i, codes[i], results[i])
		}
	}
}

// ── submodule sync ──

// sync 실패가 index.lock 이면 409 index_locked + lock 필드. 쓰기 단계는 서버 루트
// 파생 + 180s 이며 요청 취소가 번지지 않는다.
func TestSubmoduleSync_IndexLockedCarriesLockAndRootCtx(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := gitWriteServer(t, f)
	var deadline time.Time
	s.Submodules = submodule.New(func(ctx context.Context, _ string, _ ...string) (string, error) {
		deadline, _ = ctx.Deadline()
		return "", fmt.Errorf("git submodule sync: %w", core.ErrIndexLocked)
	})
	if err := os.WriteFile(filepath.Join(f.gitDir, "index.lock"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	code, out := gitReq(t, s, http.MethodPost, "/api/git/submodules/sync", `{"repo":`+qWorkRepo+`,"confirm":true}`)
	if code != http.StatusConflict || out["error"] != apierr.CodeIndexLocked || out["lock"] == nil {
		t.Fatalf("= %d %+v, want 409 index_locked + lock", code, out)
	}
	if left := time.Until(deadline); left < core.ManagerWriteTimeout-10*time.Second {
		t.Fatalf("쓰기 단계 마감이 %v 남았다 — want ≈ %v", left, core.ManagerWriteTimeout)
	}
}

// 종료로 끊긴 sync 는 503 server_shutdown.
func TestSubmoduleSync_ShutdownIs503(t *testing.T) {
	f := newGitWriteFake(t)
	s, cancel := shutdownServer(t, f)
	s.Submodules = submodule.New(func(ctx context.Context, _ string, _ ...string) (string, error) {
		cancel()
		<-ctx.Done()
		return "", fmt.Errorf("git submodule sync: %w", core.ErrCanceled)
	})
	code, out := gitReq(t, s, http.MethodPost, "/api/git/submodules/sync", `{"repo":`+qWorkRepo+`,"confirm":true}`)
	if code != http.StatusServiceUnavailable || out["error"] != apierr.CodeServerShutdown {
		t.Fatalf("= %d %+v, want 503 server_shutdown", code, out)
	}
}

// Git 이 없는 배선에서도 잡 키의 common 은 common-dir 이다 (FR-GXU-4).
func TestJobKeys_WithoutGitUsesCommonDir(t *testing.T) {
	repo := wtTempRepo(t)
	s := &GitServer{}
	k, err := s.jobKeys(context.Background(), repo)
	if err != nil {
		t.Fatal(err)
	}
	if k.Common != core.ExclusionKey(filepath.Join(repo, ".git")) {
		t.Fatalf("common = %q", k.Common)
	}
}
