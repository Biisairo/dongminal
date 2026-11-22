package jobs

import (
	"context"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"dongminal/internal/webserver/domain/git/core"
)

// ATTIC_FIX_SRS 묶음 ATT-1 — 잡 수명의 결함 (PROD3_ATTIC AT-GJB-1·2·4·8).

func jobCommitSpec() core.WriteSpec {
	return core.WriteSpec{Argv: []string{"commit", "--file=-", "--cleanup=strip"}, Stdin: "m"}
}

// TC-ATF-6 (FR-ATF-6, D-ATF-3): finish 에 든 잡의 Cancel 은 false 다. 이전: 완료 훅이
// 도는 동안 Cancel 이 true 를 돌려줬지만 결과에는 반영되지 않았다 — 취소 응답을 받은
// 잡이 성공으로 남았다. 새: 이미 끝나는 중이라 false 다.
func TestJobCancel_FalseWhileFinishing(t *testing.T) {
	inHook := make(chan struct{})
	release := make(chan struct{})
	j := NewJobs(jobSvc(), WithJobRunner(jobDoneRunner(0, "")))
	jb, err := j.Start(jobRepo, keysOf(jobRepo), "commit", jobCommitSpec(), OnFinish(func(context.Context, *Job) {
		close(inHook)
		<-release
	}))
	if err != nil {
		t.Fatal(err)
	}
	<-inHook
	got := j.Cancel(jb.ID)
	close(release)
	final := jobWait(t, j, jb.ID, 2*time.Second)
	if got {
		t.Fatal("완료 훅이 도는 동안 Cancel 이 true 를 돌려줬다")
	}
	if final.Canceled || final.Err != "" {
		t.Fatalf("결과가 바뀌었다: %+v", final)
	}
}

// TC-ATF-7 (FR-ATF-7, AT-GJB-2): 보존 상한을 넘어도 줄마다 자르지 않고, 상한의 두 배에
// 닿을 때 한 번에 자른다. 보이는 줄 수는 그대로 상한이다.
func TestJob_LineCapTrimsInBulk(t *testing.T) {
	const lineCap = 4
	emitted := make(chan int)
	next := make(chan struct{})
	j := NewJobs(jobSvc(), WithJobRunner(func(_ context.Context, _ string, _ []string, _ string, emit func(string, string)) (int, error) {
		for i := 1; i <= 2*lineCap; i++ {
			emit(LineStdout, "줄 "+strconv.Itoa(i))
			emitted <- i
			<-next
		}
		return 0, nil
	}))
	j.lineCap = lineCap
	jb, err := j.Start(jobRepo, keysOf(jobRepo), "fetch", jobFetchSpec())
	if err != nil {
		t.Fatal(err)
	}
	stored := func() int {
		j.mu.Lock()
		defer j.mu.Unlock()
		return len(j.byID[jb.ID].lines)
	}
	for range 2 * lineCap {
		n := <-emitted
		want := n
		if n == 2*lineCap {
			want = lineCap
		}
		if got := stored(); got != want {
			t.Fatalf("%d 줄 뒤 보존 = %d, want %d", n, got, want)
		}
		if n == lineCap+2 {
			ch, unsub, _ := j.Subscribe(jb.ID, 0)
			var seqs []uint64
			for len(seqs) < lineCap {
				seqs = append(seqs, (<-ch).Seq)
			}
			unsub()
			if seqs[0] != 3 || len(ch) != 0 {
				t.Fatalf("재생 = %v (남은 %d), want 3..6 의 %d 줄", seqs, len(ch), lineCap)
			}
		}
		next <- struct{}{}
	}
	jobWait(t, j, jb.ID, 2*time.Second)
}

// TC-ATF-8 (FR-ATF-8, D-ATF-4): 실행기의 panic 은 그 잡의 실패이고 칸이 빈다. 이전:
// 잡 고루틴에 recover 가 없어 서버가 죽었다.
func TestJob_RunnerPanicFailsJobAndFreesSlot(t *testing.T) {
	x := NewExclusion()
	j := NewJobs(jobSvc(), WithExclusion(x), WithJobRunner(func(context.Context, string, []string, string, func(string, string)) (int, error) {
		panic("실행기 고장")
	}))
	jb, err := j.Start(jobRepo, keysOf(jobRepo), "commit", jobCommitSpec())
	if err != nil {
		t.Fatal(err)
	}
	final := jobWait(t, j, jb.ID, 2*time.Second)
	if !strings.Contains(final.Err, "panic") {
		t.Fatalf("Err = %q", final.Err)
	}
	if _, busy := x.IndexBusy(jobRepo); busy {
		t.Fatal("panic 뒤에도 칸이 찼다")
	}
}

// FR-ATF-8: 완료 훅의 panic 도 그 잡의 실패이고 칸이 빈다.
func TestJob_FinisherPanicFailsJobAndFreesSlot(t *testing.T) {
	for _, c := range []struct {
		name string
		opts []JobsOption
		st   []StartOption
	}{
		{"onDone", []JobsOption{WithOnDone(func(*Job) { panic("훅 고장") })}, nil},
		{"finish", nil, []StartOption{OnFinish(func(context.Context, *Job) { panic("훅 고장") })}},
	} {
		t.Run(c.name, func(t *testing.T) {
			x := NewExclusion()
			opts := append([]JobsOption{WithExclusion(x), WithJobRunner(jobDoneRunner(0, ""))}, c.opts...)
			j := NewJobs(jobSvc(), opts...)
			jb, err := j.Start(jobRepo, keysOf(jobRepo), "commit", jobCommitSpec(), c.st...)
			if err != nil {
				t.Fatal(err)
			}
			final := jobWait(t, j, jb.ID, 2*time.Second)
			if !strings.Contains(final.Err, "panic") {
				t.Fatalf("Err = %q", final.Err)
			}
			if _, busy := x.IndexBusy(jobRepo); busy {
				t.Fatal("panic 뒤에도 칸이 찼다")
			}
		})
	}
}

// TC-ATF-10 (FR-ATF-10, AT-GJB-8): 상한 줄 끊기는 UTF-8 룬 경계에서 한다. 이전:
// 4096바이트에서 끊어 한글 한 글자가 두 줄로 쪼개져 깨졌다.
func TestReadLines_CutsOnRuneBoundary(t *testing.T) {
	head := strings.Repeat("a", JobLineMax-1)
	var got []string
	readLines(strings.NewReader(head+"가나\n"), func(s string) { got = append(got, s) })
	if len(got) != 2 || got[0] != head || got[1] != "가나" {
		t.Fatalf("줄 = %d개 %q…", len(got), got[len(got)-1])
	}
	for i, s := range got {
		if !utf8.ValidString(s) {
			t.Fatalf("%d 번째 줄이 깨졌다: %q", i, s[len(s)-3:])
		}
	}
}
