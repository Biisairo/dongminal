package jobs

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/webserver/domain/git/core"
)

// 12단계 — 작업(job) 인프라 (GIT_SRS §3B.1 FR-GIT-101~104, 검증 V42·V43).
//
// 원격 작업은 다른 git 실행과 성질이 다르다: 분 단위이고, 출력이 진행 상황이며,
// 취소할 수 있어야 한다. 그 셋을 여기서 못박는다.

var jobRepo = absWorkRepo

// jobSvc 는 읽기·쓰기 실행기를 함께 막은 Service 다. 작업 경로는 svc 의 기록만
// 쓰지만, 막지 않으면 실제 git 이 돌 수 있는 자리를 남긴다.
func jobSvc() *core.Service {
	return core.New(
		core.WithRunner(func(context.Context, string, []string) (core.Output, error) { return core.Output{}, nil }),
		core.WithWriteRunner(func(context.Context, string, []string, string) (core.Output, error) { return core.Output{}, nil }),
	)
}

// jobBlockRunner 는 취소되거나 상한을 넘길 때까지 매달린다. 취소 검증이 실제
// 네트워크에 의존하면 결정론을 잃는다.
func jobBlockRunner(started chan struct{}) JobRunner {
	var once sync.Once
	return func(ctx context.Context, _ string, _ []string, emit func(string, string)) (int, error) {
		emit(LineStderr, "remote: 세는 중")
		if started != nil {
			once.Do(func() { close(started) })
		}
		<-ctx.Done()
		return -1, ctx.Err()
	}
}

func jobFetchSpec() core.WriteSpec { return core.WriteSpec{Argv: []string{"fetch", "--progress"}} }

// jobWait 는 작업이 끝나기를 기다린다. 폴링 간격은 짧게 둔다 — 대기가 테스트
// 시간을 지배하면 안 된다.
func jobWait(t *testing.T, j *Jobs, id string, d time.Duration) *Job {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if jb, ok := j.Get(id); ok && jb.Done {
			return jb
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("작업 %s 가 %v 안에 끝나지 않았다", id, d)
	return nil
}

// R1 (V42, FR-GIT-102): 취소가 프로세스를 끝내고 그 사실이 작업에 남는다.
func TestJobCancel_EndsJobAndMarksCanceled(t *testing.T) {
	started := make(chan struct{})
	j := NewJobs(jobSvc(), WithJobRunner(jobBlockRunner(started)))
	jb, err := j.Start(jobRepo, "fetch", jobFetchSpec())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	<-started
	if !j.Cancel(jb.ID) {
		t.Fatal("Cancel 이 거짓을 돌려줬다")
	}
	done := jobWait(t, j, jb.ID, 2*time.Second)
	if !done.Canceled {
		t.Fatalf("Canceled = false: %+v", done)
	}
	if done.Err == "" {
		t.Fatal("취소 사유가 비었다 — 부분 적용 가능성을 알릴 수 없다")
	}
	// 끝난 작업은 진행 중 목록에서 빠진다 (FR-GIT-112).
	if len(j.Active()) != 0 {
		t.Fatalf("Active = %v", j.Active())
	}
}

// R1 (V42): 취소가 **프로세스 그룹**을 끝낸다. 리더만 죽이면 git 이 띄운
// ssh·git-remote-https 가 남아 취소가 취소가 아니다.
func TestExecStream_CancelKillsProcessGroup(t *testing.T) {
	sh := jobShell(t)
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "child.pid")
	// 자식을 하나 띄우고 그 pid 를 적은 뒤 매달린다. 자식은 우리의 직접 자식이
	// 아니므로, 리더만 죽으면 살아남는다.
	script := "sleep 300 & echo $! > " + pidFile + "; wait"

	ctx, cancel := context.WithCancel(context.Background())
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		execStream(ctx, dir, sh, []string{"-c", script}, func(string, string) {})
	}()

	child := jobAwaitPid(t, pidFile)
	cancel()
	select {
	case <-exited:
	case <-time.After(10 * time.Second):
		t.Fatal("execStream 이 취소 후에도 돌아오지 않았다")
	}
	jobAwaitGone(t, child, 5*time.Second)
}

// R1 (V42): SIGTERM 을 무시하는 자식도 유예 뒤 SIGKILL 로 끝난다. 유예가 없으면
// 완강한 자식이 파이프를 잡고 작업이 영원히 끝나지 않는다.
func TestExecStream_CancelEscalatesToKill(t *testing.T) {
	sh := jobShell(t)
	dir := t.TempDir()
	pidFile := filepath.Join(dir, "stubborn.pid")
	// TERM 을 무시하는 셸을 띄운다. sleep 이 죽어도 루프가 다시 띄우므로 이 자식은
	// SIGTERM 으로는 끝나지 않는다.
	inner := "trap '' TERM; while true; do sleep 1; done"
	script := sh + " -c \"" + inner + "\" & echo $! > " + pidFile + "; wait"

	ctx, cancel := context.WithCancel(context.Background())
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		execStream(ctx, dir, sh, []string{"-c", script}, func(string, string) {})
	}()

	child := jobAwaitPid(t, pidFile)
	cancel()
	select {
	case <-exited:
	case <-time.After(3*JobKillGrace + 10*time.Second):
		t.Fatal("execStream 이 유예를 넘겨서도 돌아오지 않았다")
	}
	jobAwaitGone(t, child, 5*time.Second)
}

// R2 (V42, FR-GIT-103): `\r` 로 갱신되는 진행 줄이 개별 줄로 갈린다.
// bufio.Scanner 의 기본 분할은 `\n` 뿐이라 git 의 진행 표시를 통째로 놓친다.
func TestReadLines_SplitsOnCarriageReturn(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{
			"진행 갱신",
			"Receiving objects:  1%\rReceiving objects: 52%\rReceiving objects: 100%\rdone.\n",
			[]string{"Receiving objects:  1%", "Receiving objects: 52%", "Receiving objects: 100%", "done."},
		},
		{"CRLF 는 한 줄 끝", "a\r\nb\r\n", []string{"a", "b"}},
		{"끝에 구분자 없음", "tail", []string{"tail"}},
		{"빈 줄은 버린다", "a\n\n\nb\n", []string{"a", "b"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var got []string
			readLines(strings.NewReader(c.in), func(s string) { got = append(got, s) })
			if fmt.Sprint(got) != fmt.Sprint(c.want) {
				t.Fatalf("줄 = %q, want %q", got, c.want)
			}
		})
	}
}

// R2 (V42): 실제 프로세스가 `\r` 로 낸 진행이 개별 Line 으로 도착한다.
func TestJob_ProgressLinesArriveIndividually(t *testing.T) {
	sh := jobShell(t)
	var got []string
	script := `printf 'Receiving objects:  1%%\rReceiving objects: 100%%\rdone.\n' 1>&2`
	_, err := execStream(context.Background(), t.TempDir(), sh, []string{"-c", script},
		func(stream, text string) {
			if stream != LineStderr {
				t.Errorf("stream = %q", stream)
			}
			got = append(got, text)
		})
	if err != nil {
		t.Fatalf("execStream: %v", err)
	}
	want := []string{"Receiving objects:  1%", "Receiving objects: 100%", "done."}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("줄 = %q, want %q", got, want)
	}
}

// R3 (V40, FR-GIT-101): 같은 리포의 두 번째 Start 는 ErrJobBusy 다.
func TestJobStart_SameRepoIsBusy(t *testing.T) {
	started := make(chan struct{})
	j := NewJobs(jobSvc(), WithJobRunner(jobBlockRunner(started)))
	first, err := j.Start(jobRepo, "fetch", jobFetchSpec())
	if err != nil {
		t.Fatalf("첫 Start: %v", err)
	}
	<-started
	if _, err := j.Start(jobRepo, "push", core.WriteSpec{Argv: []string{"push", "--progress"}}); !errors.Is(err, ErrJobBusy) {
		t.Fatalf("두 번째 Start err = %v, want ErrJobBusy", err)
	}
	// 끝나면 다시 받는다 — 한 번의 실패가 리포를 영구히 막지 않는다.
	j.Cancel(first.ID)
	jobWait(t, j, first.ID, 2*time.Second)
	if _, err := j.Start(jobRepo, "fetch", jobFetchSpec()); err != nil {
		t.Fatalf("끝난 뒤 Start: %v", err)
	}
}

// R4: 다른 리포의 작업은 서로를 막지 않는다.
func TestJobStart_OtherRepoNotBlocked(t *testing.T) {
	j := NewJobs(jobSvc(), WithJobRunner(jobBlockRunner(nil)))
	if _, err := j.Start(absWorkA, "fetch", jobFetchSpec()); err != nil {
		t.Fatalf("/work/a: %v", err)
	}
	if _, err := j.Start(absWorkB, "fetch", jobFetchSpec()); err != nil {
		t.Fatalf("/work/b: %v", err)
	}
	if n := len(j.Active()); n != 2 {
		t.Fatalf("Active = %d, want 2", n)
	}
}

// R8 (O9): 상한을 넘긴 작업은 종료되고 Err 에 사유가 남는다. 상한이 없으면
// 브라우저를 닫은 사용자의 고아 프로세스가 영구히 남는다.
func TestJob_CeilingEndsJobWithReason(t *testing.T) {
	j := NewJobs(jobSvc(), WithJobRunner(jobBlockRunner(nil)), WithCeiling(30*time.Millisecond))
	jb, err := j.Start(jobRepo, "fetch", jobFetchSpec())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	done := jobWait(t, j, jb.ID, 3*time.Second)
	if done.Canceled {
		t.Fatal("상한 초과는 사용자의 취소가 아니다")
	}
	if !strings.Contains(done.Err, "상한") {
		t.Fatalf("Err = %q — 상한을 넘겼다는 사실이 없다", done.Err)
	}
}

// R9: JobLineCap 초과 시 앞에서 버리고 Seq 는 단조 증가한다.
func TestJob_LineCapDropsFromFront(t *testing.T) {
	const extra = 100
	emitted := make(chan struct{})
	j := NewJobs(jobSvc(), WithJobRunner(func(_ context.Context, _ string, _ []string, emit func(string, string)) (int, error) {
		for i := 0; i < JobLineCap+extra; i++ {
			emit(LineStdout, "줄 "+strconv.Itoa(i))
		}
		close(emitted)
		return 0, nil
	}))
	jb, err := j.Start(jobRepo, "fetch", jobFetchSpec())
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	<-emitted
	jobWait(t, j, jb.ID, 3*time.Second)

	ch, unsub, ok := j.Subscribe(jb.ID, 0)
	if !ok {
		t.Fatal("Subscribe 가 거짓을 돌려줬다")
	}
	defer unsub()
	var lines []Line
	for ln := range ch {
		lines = append(lines, ln)
	}
	if len(lines) != JobLineCap {
		t.Fatalf("보존 줄 = %d, want %d", len(lines), JobLineCap)
	}
	if lines[0].Seq != extra+1 {
		t.Fatalf("첫 Seq = %d, want %d — 앞에서 버리지 않았다", lines[0].Seq, extra+1)
	}
	for i := 1; i < len(lines); i++ {
		if lines[i].Seq != lines[i-1].Seq+1 {
			t.Fatalf("Seq 가 단조 증가하지 않는다: %d → %d", lines[i-1].Seq, lines[i].Seq)
		}
	}
}

// Subscribe 는 afterSeq 이후만 준다 — 재연결이 이미 본 줄을 다시 그리지 않아야
// 한다.
func TestJobSubscribe_AfterSeq(t *testing.T) {
	j := NewJobs(jobSvc(), WithJobRunner(func(_ context.Context, _ string, _ []string, emit func(string, string)) (int, error) {
		for i := 1; i <= 5; i++ {
			emit(LineStdout, "줄 "+strconv.Itoa(i))
		}
		return 0, nil
	}))
	jb, _ := j.Start(jobRepo, "fetch", jobFetchSpec())
	jobWait(t, j, jb.ID, 3*time.Second)

	ch, unsub, ok := j.Subscribe(jb.ID, 3)
	if !ok {
		t.Fatal("Subscribe 가 거짓을 돌려줬다")
	}
	defer unsub()
	var seqs []uint64
	for ln := range ch {
		seqs = append(seqs, ln.Seq)
	}
	if fmt.Sprint(seqs) != fmt.Sprint([]uint64{4, 5}) {
		t.Fatalf("seq = %v, want [4 5]", seqs)
	}
}

// 진행 중 작업의 구독은 새 줄을 받고, 끝나면 채널이 닫힌다.
func TestJobSubscribe_LiveThenClose(t *testing.T) {
	release := make(chan struct{})
	j := NewJobs(jobSvc(), WithJobRunner(func(_ context.Context, _ string, _ []string, emit func(string, string)) (int, error) {
		<-release
		emit(LineStderr, "진행 중")
		return 0, nil
	}))
	jb, _ := j.Start(jobRepo, "fetch", jobFetchSpec())
	ch, unsub, ok := j.Subscribe(jb.ID, 0)
	if !ok {
		t.Fatal("Subscribe 가 거짓을 돌려줬다")
	}
	defer unsub()
	close(release)

	ln, more := <-ch
	if !more || ln.Text != "진행 중" || ln.Stream != LineStderr {
		t.Fatalf("첫 줄 = %+v (more=%v)", ln, more)
	}
	if _, more := <-ch; more {
		t.Fatal("작업이 끝났는데 채널이 닫히지 않았다")
	}
}

// 알 수 없는 작업의 구독은 거짓이다 — 조용히 빈 스트림을 주면 클라이언트가
// 영원히 기다린다.
func TestJobSubscribe_UnknownID(t *testing.T) {
	j := NewJobs(jobSvc())
	if _, _, ok := j.Subscribe("없는-작업", 0); ok {
		t.Fatal("없는 작업의 Subscribe 가 참이다")
	}
	if _, ok := j.Get("없는-작업"); ok {
		t.Fatal("없는 작업의 Get 이 참이다")
	}
	if j.Cancel("없는-작업") {
		t.Fatal("없는 작업의 Cancel 이 참이다")
	}
}

// 작업 경로는 원격 작업만 태운다. 짧은 명령을 여기 태우면 취소·스트리밍 기계장치가
// 값어치 없이 붙는다.
func TestJobStart_RejectsNonRemoteKind(t *testing.T) {
	j := NewJobs(jobSvc(), WithJobRunner(jobBlockRunner(nil)))
	cases := []struct {
		name string
		repo string
		kind string
		argv []string
	}{
		{"작업이 아닌 종류", jobRepo, "commit", []string{"commit", "-m", "x"}},
		{"kind 와 argv 불일치", jobRepo, "fetch", []string{"push", "--progress"}},
		{"읽기 명령", jobRepo, "fetch", []string{"status"}},
		{"상대 경로", "repo", "fetch", []string{"fetch", "--progress"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := j.Start(c.repo, c.kind, core.WriteSpec{Argv: c.argv}); err == nil {
				t.Fatal("거부되지 않았다")
			}
		})
	}
}

// 끝난 작업은 보존 기간이 지나면 사라진다.
func TestJob_RetentionDropsFinished(t *testing.T) {
	now := time.Now()
	j := NewJobs(jobSvc(),
		WithJobRunner(func(context.Context, string, []string, func(string, string)) (int, error) { return 0, nil }),
		WithJobClock(func() time.Time { return now }),
	)
	jb, _ := j.Start(jobRepo, "fetch", jobFetchSpec())
	jobWait(t, j, jb.ID, 3*time.Second)
	now = now.Add(JobRetention + time.Second)
	if _, ok := j.Get(jb.ID); ok {
		t.Fatal("보존 기간이 지난 작업이 남아 있다")
	}
}

// 완료 훅은 작업당 한 번 불린다. status 캐시 무효화(FR-GIT-107)가 이것을 딛는다.
func TestJob_OnDoneCalledOnce(t *testing.T) {
	done := make(chan *Job, 4)
	j := NewJobs(jobSvc(),
		WithJobRunner(func(context.Context, string, []string, func(string, string)) (int, error) { return 0, nil }),
		WithOnDone(func(jb *Job) { done <- jb }),
	)
	jb, _ := j.Start(jobRepo, "fetch", jobFetchSpec())
	select {
	case got := <-done:
		if got.ID != jb.ID || got.Repo != jobRepo || !got.Done {
			t.Fatalf("훅이 받은 작업 = %+v", got)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("완료 훅이 불리지 않았다")
	}
	select {
	case got := <-done:
		t.Fatalf("훅이 두 번 불렸다: %+v", got)
	case <-time.After(50 * time.Millisecond):
	}
}

// 인증 실패는 감지만 하고 자격증명을 요구하지 않는다 (FR-GIT-104, O10).
func TestJob_AuthRequiredFromStderr(t *testing.T) {
	j := NewJobs(jobSvc(), WithJobRunner(func(_ context.Context, _ string, _ []string, emit func(string, string)) (int, error) {
		emit(LineStderr, "fatal: could not read Username for 'https://example.com': terminal prompts disabled")
		return 128, nil
	}))
	jb, _ := j.Start(jobRepo, "push", core.WriteSpec{Argv: []string{"push", "--progress"}})
	done := jobWait(t, j, jb.ID, 3*time.Second)
	if !done.AuthRequired {
		t.Fatalf("AuthRequired = false: %+v", done)
	}
	if !strings.Contains(done.StderrTail, "terminal prompts disabled") {
		t.Fatalf("StderrTail = %q", done.StderrTail)
	}
	// 실행기가 오류를 주지 않아도 exit 는 실패를 말한다 (FR-GIT-108).
	if done.Err == "" {
		t.Fatalf("exit %d 인데 사유가 비었다", done.ExitCode)
	}
}

// R7 의 짝 (FR-GIT-105): non-fast-forward 거부는 사유와 후속 선택지를 남기고
// **force 를 기본 제안하지 않는다** — 목록에서 마지막이다.
func TestJob_RejectedOffersFetchFirst(t *testing.T) {
	j := NewJobs(jobSvc(), WithJobRunner(func(_ context.Context, _ string, _ []string, emit func(string, string)) (int, error) {
		emit(LineStderr, " ! [rejected]        main -> main (non-fast-forward)")
		return 1, nil
	}))
	jb, _ := j.Start(jobRepo, "push", core.WriteSpec{Argv: []string{"push", "--progress"}})
	done := jobWait(t, j, jb.ID, 3*time.Second)
	if !done.Rejected {
		t.Fatalf("Rejected = false: %+v", done)
	}
	if len(done.Options) == 0 {
		t.Fatal("후속 선택지가 없다")
	}
	if done.Options[0] == FixForceWithLease {
		t.Fatalf("force 가 첫 제안이다: %v", done.Options)
	}
	if done.Options[len(done.Options)-1] != FixForceWithLease {
		t.Fatalf("force 가 마지막이 아니다: %v", done.Options)
	}
}

// jobShell 은 프로세스 그룹·스트리밍 검증에 쓸 셸이다. 없으면 그 검증을 건너뛴다.
func jobShell(t *testing.T) string {
	t.Helper()
	const sh = "/bin/sh"
	if _, err := os.Stat(sh); err != nil {
		t.Skipf("%s 가 없다: %v", sh, err)
	}
	return sh
}

// jobAwaitPid 는 스크립트가 적은 자식 pid 를 읽는다.
func jobAwaitPid(t *testing.T, path string) int {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		b, err := os.ReadFile(path)
		if err == nil {
			if pid, cerr := strconv.Atoi(strings.TrimSpace(string(b))); cerr == nil && pid > 0 {
				return pid
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s 에서 자식 pid 를 읽지 못했다", path)
	return 0
}

// jobAwaitGone 은 pid 가 사라지기를 기다린다. 신호 0 은 존재 확인이다.
func jobAwaitGone(t *testing.T, pid int, d time.Duration) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if !platform.Current().Process.Alive(pid) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	_ = platform.Current().Process.Kill(pid)
	t.Fatalf("pid %d 가 살아 있다 — 프로세스 그룹이 끝나지 않았다", pid)
}

// R5 (V43): argv·출력 줄·실행 기록 **전부**에서 자격증명이 사라진다. 한 곳만 늦게
// 지우면 그곳이 유출 경로가 된다.
func TestJob_SanitizesCredentialsEverywhere(t *testing.T) {
	const secretURL = "https://user:s3cr3t@example.com/o/r.git"
	svc := jobSvc()
	j := NewJobs(svc, WithJobRunner(func(_ context.Context, _ string, args []string, emit func(string, string)) (int, error) {
		// 실행기는 **지워지지 않은** argv 를 받는다 — git 이 실제로 밀어야 하는 값이다.
		if !strings.Contains(strings.Join(args, " "), "s3cr3t") {
			return -1, fmt.Errorf("실행기가 원본 argv 를 받지 못했다: %v", args)
		}
		emit(LineStderr, "fatal: unable to access '"+secretURL+"': 401")
		return 128, nil
	}))
	jb, err := j.Start(jobRepo, "push", core.WriteSpec{Argv: []string{"push", "--progress", secretURL, "main"}})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	done := jobWait(t, j, jb.ID, 3*time.Second)

	blob := fmt.Sprint(jb.Argv) + "\n" + fmt.Sprint(done.Argv) + "\n" + done.Err + "\n" + done.StderrTail
	ch, unsub, ok := j.Subscribe(jb.ID, 0)
	if !ok {
		t.Fatal("Subscribe 가 거짓을 돌려줬다")
	}
	defer unsub()
	for ln := range ch {
		blob += "\n" + ln.Text
	}
	for _, rec := range svc.Records(0) {
		blob += "\n" + fmt.Sprint(rec.Argv) + "\n" + rec.Stderr + "\n" + rec.Err
	}
	if strings.Contains(blob, "s3cr3t") {
		t.Fatalf("자격증명이 남았다:\n%s", blob)
	}
	if !strings.Contains(blob, "***@example.com") {
		t.Fatalf("지운 흔적이 없다 — 검사가 무의미하다:\n%s", blob)
	}
}
