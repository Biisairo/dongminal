package jobs

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/git/core"
)

// REPO_FIX 01 §6.1~6.3 — 잡으로 옮긴 쓰기. kind 표·모양 제약·stdin·완료 처리.

// jobDoneRunner 는 곧바로 exit 로 끝나며 stderr 를 한 줄 낸다.
func jobDoneRunner(exit int, stderr string) JobRunner {
	return func(_ context.Context, _ string, _ []string, _ string, emit func(string, string)) (int, error) {
		if stderr != "" {
			emit(LineStderr, stderr)
		}
		return exit, nil
	}
}

func TestJobStart_KindTableAcceptsShapes(t *testing.T) {
	cases := []struct {
		kind  string
		argv  []string
		stdin string
	}{
		{"commit", []string{"commit", "--file=-", "--cleanup=strip"}, "msg"},
		{"commit", []string{"commit", "--file=-", "--cleanup=strip", "--amend", "--signoff", "--no-verify", "-a"}, "msg"},
		{"merge", []string{"merge", "feature"}, ""},
		{"merge", []string{"merge", "--no-ff", "feature"}, ""},
		{"merge", []string{"merge", "--continue"}, ""},
		{"merge", []string{"merge", "--abort"}, ""},
		{"rebase", []string{"rebase", "main"}, ""},
		{"rebase", []string{"rebase", "--onto", "abc^", "abc"}, ""},
		{"rebase", []string{"rebase", "--skip"}, ""},
		{"cherry-pick", []string{"cherry-pick", "abc"}, ""},
		{"cherry-pick", []string{"cherry-pick", "-m", "1", "abc"}, ""},
		{"cherry-pick", []string{"cherry-pick", "--continue"}, ""},
		{"revert", []string{"revert", "-m", "2", "--no-commit", "abc"}, ""},
		{"revert", []string{"revert", "--abort"}, ""},
		{"checkout", []string{"checkout", "main"}, ""},
		{"checkout", []string{"checkout", "--force", "--detach", "abc"}, ""},
		{"checkout", []string{"checkout", "-b", "new", "--track", "origin/new"}, ""},
		{"checkout", []string{"checkout", "-b", "new", "main"}, ""},
		{"checkout", []string{"checkout", "-b", "new"}, ""},
		{"am", []string{"am", "--skip"}, ""},
		{"bisect", []string{"bisect", "reset"}, ""},
	}
	for _, c := range cases {
		t.Run(strings.Join(c.argv, " "), func(t *testing.T) {
			j := NewJobs(jobSvc(), WithJobRunner(jobDoneRunner(0, "")))
			jb, err := j.Start(jobRepo, keysOf(jobRepo), c.kind, core.WriteSpec{Argv: c.argv, Stdin: c.stdin})
			if err != nil {
				t.Fatalf("거부됐다: %v", err)
			}
			jobWait(t, j, jb.ID, 2*time.Second)
		})
	}
}

func TestJobStart_KindTableRejectsShapes(t *testing.T) {
	cases := []struct {
		name  string
		kind  string
		argv  []string
		stdin string
	}{
		{"commit 메시지 인자", "commit", []string{"commit", "-m", "x"}, ""},
		{"commit stdin 없음", "commit", []string{"commit", "--file=-", "--cleanup=strip"}, ""},
		{"commit 모르는 플래그", "commit", []string{"commit", "--file=-", "--cleanup=strip", "--allow-empty"}, "m"},
		{"merge 위치 둘", "merge", []string{"merge", "a", "b"}, ""},
		{"merge 제어 뒤 인자", "merge", []string{"merge", "--abort", "x"}, ""},
		{"merge skip 없음", "merge", []string{"merge", "--skip"}, ""},
		{"rebase -i", "rebase", []string{"rebase", "-i", "main"}, ""},
		{"cherry-pick --no-commit", "cherry-pick", []string{"cherry-pick", "--no-commit", "abc"}, ""},
		{"revert -m 숫자 아님", "revert", []string{"revert", "-m", "x", "abc"}, ""},
		{"checkout -B", "checkout", []string{"checkout", "-B", "x"}, ""},
		{"checkout track 단독", "checkout", []string{"checkout", "--track", "origin/x"}, ""},
		{"checkout 위치 둘", "checkout", []string{"checkout", "a", "b"}, ""},
		{"am 모르는 제어", "am", []string{"am", "--quit"}, ""},
		{"bisect good", "bisect", []string{"bisect", "good"}, ""},
		{"submodule 은 Start 가 아니다", "submodule", []string{"submodule", "update"}, ""},
		{"worktree 는 Start 가 아니다", "worktree", []string{"worktree", "add", "x"}, ""},
		{"표에 없는 kind", "reset", []string{"reset", "--hard"}, ""},
		{"kind 와 argv 불일치", "merge", []string{"rebase", "main"}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			j := NewJobs(jobSvc(), WithJobRunner(jobDoneRunner(0, "")))
			// 쓰기 가드가 먼저 거절하는 것(허용 목록 밖·금지 하위 명령)도 거절이다.
			_, err := j.Start(jobRepo, keysOf(jobRepo), c.kind, core.WriteSpec{Argv: c.argv, Stdin: c.stdin})
			if !errors.Is(err, ErrJobKind) && !errors.Is(err, core.ErrUnsafeArgument) && !errors.Is(err, core.ErrWriteCommand) {
				t.Fatalf("err = %v, want 거절", err)
			}
		})
	}
}

// §6.1: StartUnguarded 는 submodule·worktree 만, worktree 는 `worktree add` 만.
func TestJobStartUnguarded_KindTable(t *testing.T) {
	j := NewJobs(jobSvc(), WithJobRunner(jobDoneRunner(0, "")))
	if _, err := j.StartUnguarded(jobRepo, keysOf(jobRepo), "fetch", []string{"fetch"}, "x"); !errors.Is(err, ErrJobKind) {
		t.Fatalf("fetch err = %v, want ErrJobKind", err)
	}
	if _, err := j.StartUnguarded(jobRepo, keysOf(jobRepo), "worktree", []string{"worktree", "remove", "x"}, "x"); !errors.Is(err, ErrJobKind) {
		t.Fatalf("worktree remove err = %v, want ErrJobKind", err)
	}
	jb, err := j.StartUnguarded(absWorkA, keysOf(absWorkA), "worktree", []string{"worktree", "add", "-b", "x", "/p"}, "x")
	if err != nil {
		t.Fatalf("worktree add: %v", err)
	}
	jobWait(t, j, jb.ID, 2*time.Second)
}

// §6.2: stdin 은 실행기에 가고, Job JSON·줄·기록에는 싣지 않는다(기록은 바이트 수).
func TestJob_StdinReachesRunnerOnly(t *testing.T) {
	const secret = "커밋 메시지 비밀-본문"
	var got string
	svc := jobSvc()
	j := NewJobs(svc, WithJobRunner(func(_ context.Context, _ string, _ []string, stdin string, emit func(string, string)) (int, error) {
		got = stdin
		emit(LineStdout, "[main abc] ok")
		return 0, nil
	}))
	jb, err := j.Start(jobRepo, keysOf(jobRepo), "commit", core.WriteSpec{Argv: []string{"commit", "--file=-", "--cleanup=strip"}, Stdin: secret})
	if err != nil {
		t.Fatal(err)
	}
	final := jobWait(t, j, jb.ID, 2*time.Second)
	if got != secret {
		t.Fatalf("실행기 stdin = %q", got)
	}
	raw, _ := json.Marshal(final)
	if strings.Contains(string(raw), secret) {
		t.Fatalf("Job JSON 에 stdin 이 실렸다: %s", raw)
	}
	recs := svc.Records(1)
	if len(recs) != 1 || recs[0].StdinBytes != len(secret) {
		t.Fatalf("기록 = %+v, want StdinBytes %d", recs, len(secret))
	}
	if raw, _ := json.Marshal(recs[0]); strings.Contains(string(raw), secret) {
		t.Fatal("기록에 stdin 이 실렸다")
	}
}

// §6.3: slots 는 kind 에서 서버가 파생한다.
func TestJob_SlotsInJSON(t *testing.T) {
	j := NewJobs(jobSvc(), WithJobRunner(jobDoneRunner(0, "")))
	jb, _ := j.Start(jobRepo, keysOf(jobRepo), "pull", core.WriteSpec{Argv: []string{"pull", "--progress"}})
	if strings.Join(jb.Slots, ",") != "index,common" {
		t.Fatalf("pull slots = %v", jb.Slots)
	}
	jobWait(t, j, jb.ID, 2*time.Second)
	jb2, _ := j.Start(jobRepo, keysOf(jobRepo), "commit", core.WriteSpec{Argv: []string{"commit", "--file=-", "--cleanup=strip"}, Stdin: "m"})
	if strings.Join(jb2.Slots, ",") != "index" {
		t.Fatalf("commit slots = %v", jb2.Slots)
	}
	jobWait(t, j, jb2.ID, 2*time.Second)
}

// §6.3: 완료 훅은 Done 공개 전·기록 뒤에 불리고, 결과를 채울 수 있다. 훅이 끝날
// 때까지 잡은 칸에 남는다.
func TestJob_FinisherFillsResultBeforePublish(t *testing.T) {
	x := NewExclusion()
	j := NewJobs(jobSvc(), WithJobRunner(jobDoneRunner(0, "")), WithExclusion(x))
	var once sync.Once
	var sawDone, sawSlot bool
	var jobs *Jobs = j
	var id string
	var idMu sync.Mutex
	finish := func(ctx context.Context, jb *Job) {
		once.Do(func() {
			idMu.Lock()
			defer idMu.Unlock()
			cur, _ := jobs.Get(jb.ID)
			sawDone = cur.Done
			_, sawSlot = x.IndexBusy(jobRepo)
			if ctx.Err() != nil {
				t.Errorf("완료 ctx 가 이미 끝났다: %v", ctx.Err())
			}
			jb.Result = &Result{Oid: "abc"}
		})
	}
	idMu.Lock()
	jb, err := j.Start(jobRepo, keysOf(jobRepo), "commit",
		core.WriteSpec{Argv: []string{"commit", "--file=-", "--cleanup=strip"}, Stdin: "m"}, OnFinish(finish))
	if err != nil {
		t.Fatal(err)
	}
	id = jb.ID
	idMu.Unlock()
	final := jobWait(t, j, id, 2*time.Second)
	if sawDone {
		t.Fatal("훅이 불릴 때 이미 Done 이 공개됐다")
	}
	if !sawSlot {
		t.Fatal("훅이 도는 동안 칸이 비었다")
	}
	if final.Result == nil || final.Result.Oid != "abc" {
		t.Fatalf("결과가 공개되지 않았다: %+v", final.Result)
	}
	if _, busy := x.IndexBusy(jobRepo); busy {
		t.Fatal("끝난 뒤에도 칸이 찼다")
	}
}

// §6.3: 원격 전용 판정(auth·reject·options)은 fetch·pull·push 에서만.
func TestJob_RemoteJudgmentsOnlyForRemoteKinds(t *testing.T) {
	j := NewJobs(jobSvc(), WithJobRunner(jobDoneRunner(1, "! [rejected] could not read Username")))
	jb, _ := j.Start(jobRepo, keysOf(jobRepo), "merge", core.WriteSpec{Argv: []string{"merge", "x"}})
	final := jobWait(t, j, jb.ID, 2*time.Second)
	if final.Rejected || final.AuthRequired || len(final.Options) > 0 {
		t.Fatalf("merge 에 원격 판정이 붙었다: %+v", final)
	}
}

// §6.3: 원격이 아닌 kind 의 취소 문구.
func TestJob_CancelMessageByKind(t *testing.T) {
	started := make(chan struct{})
	j := NewJobs(jobSvc(), WithJobRunner(func(ctx context.Context, _ string, _ []string, _ string, _ func(string, string)) (int, error) {
		close(started)
		<-ctx.Done()
		return -1, ctx.Err()
	}))
	jb, _ := j.Start(jobRepo, keysOf(jobRepo), "rebase", core.WriteSpec{Argv: []string{"rebase", "main"}})
	<-started
	j.Cancel(jb.ID)
	final := jobWait(t, j, jb.ID, 3*time.Second)
	if final.Err != "취소했다. 일부가 적용됐을 수 있다 — 상태를 확인하라" {
		t.Fatalf("취소 문구 = %q", final.Err)
	}
}

// §6.3: 상한 초과는 errorCode git_timeout.
func TestJob_TimeoutErrorCode(t *testing.T) {
	j := NewJobs(jobSvc(), WithCeiling(30*time.Millisecond), WithJobRunner(jobBlockRunner(nil)))
	jb, _ := j.Start(jobRepo, keysOf(jobRepo), "fetch", jobFetchSpec())
	final := jobWait(t, j, jb.ID, 3*time.Second)
	if final.ErrorCode != "git_timeout" {
		t.Fatalf("errorCode = %q, want git_timeout", final.ErrorCode)
	}
}

// §8: 서버 루트가 취소되면 잡은 server_shutdown 으로 끝나고 canceled 가 아니다.
func TestJob_RootCancelIsServerShutdown(t *testing.T) {
	root, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	j := NewJobs(jobSvc(), WithRoot(root), WithJobRunner(jobBlockRunner(started)))
	jb, _ := j.Start(jobRepo, keysOf(jobRepo), "fetch", jobFetchSpec())
	<-started
	cancel()
	final := jobWait(t, j, jb.ID, 3*time.Second)
	if final.ErrorCode != "server_shutdown" || final.Canceled {
		t.Fatalf("= errorCode %q canceled %v, want server_shutdown/false", final.ErrorCode, final.Canceled)
	}
	if final.Err != "서버 종료로 중단했다 — 일부가 적용됐을 수 있다" {
		t.Fatalf("err = %q", final.Err)
	}
}

// §6.3 ②: index.lock 에 막혀 끝난 잡은 errorCode index_locked 와 lock 정보를 싣는다.
func TestJob_IndexLockedErrorCode(t *testing.T) {
	gitDir := t.TempDir()
	svc := core.New(core.WithRunner(func(_ context.Context, _ string, args []string) (core.Output, error) {
		if len(args) > 1 && args[0] == "rev-parse" && args[1] == "--git-path" {
			return core.Output{Stdout: gitDir + "/index.lock\n"}, nil
		}
		return core.Output{}, nil
	}))
	j := NewJobs(svc, WithJobRunner(jobDoneRunner(128, "fatal: Unable to create '"+gitDir+"/index.lock': File exists.")))
	jb, _ := j.Start(jobRepo, keysOf(jobRepo), "merge", core.WriteSpec{Argv: []string{"merge", "x"}})
	final := jobWait(t, j, jb.ID, 2*time.Second)
	if final.ErrorCode != "index_locked" || final.Lock == nil || final.Lock.Path != gitDir+"/index.lock" {
		t.Fatalf("= errorCode %q lock %+v", final.ErrorCode, final.Lock)
	}
	if final.Lock.MtimeUnixMs != nil {
		t.Fatal("없는 파일의 mtime 을 실었다")
	}
}
