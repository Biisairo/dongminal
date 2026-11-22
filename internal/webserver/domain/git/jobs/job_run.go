package jobs

import (
	"context"
	"errors"
	"fmt"
	"runtime/debug"
	"strings"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/domain/git/core"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `job.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **작업 하나가 도는 동안 일어나는 일**이다 — 줄을 쌓고, 구독자에게
// 흘리고, 끝을 판정하고, 다 끝난 것을 치운다. `job.go` 에 남은 것은 그 바깥의
// 등록부(시작·조회·취소·구독)이며, 둘은 서로 다른 잠금 아래 산다.

// run1 은 작업 하나의 수명이다.
func (j *Jobs) run1(ctx context.Context, cancel context.CancelFunc, st *jobState) {
	defer cancel()
	started := j.now()
	exit, err := j.runGuarded(ctx, st)
	// 상한 초과는 실행기가 무엇을 돌려주든 **이것이** 사유다 (O9). 실행기의
	// 오류로 남기면 "왜 끝났는가"가 실행기 구현에 따라 달라진다.
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		err = fmt.Errorf("%w: 상한 %v 를 넘겨 종료했다", core.ErrTimeout, j.ceiling)
	}
	j.finish(st, exit, err, j.now().Sub(started))
}

// runGuarded 는 실행기를 부르고 그 panic 을 이 잡의 실패로 바꾼다 (ATTIC_FIX_SRS
// FR-ATF-8, D-ATF-4). 이전: 잡 고루틴에 recover 가 없어 서버 전체가 죽었다. 새: 잡이
// 실패로 끝나고 finish 가 칸을 비운다. 스택은 로그로.
func (j *Jobs) runGuarded(ctx context.Context, st *jobState) (exit int, err error) {
	defer func() {
		if v := recover(); v != nil {
			exit, err = -1, panicErr(st, "실행기", v)
		}
	}()
	return j.run(ctx, st.job.Repo, st.raw, st.spec.Stdin, func(stream, text string) {
		j.appendLine(st, stream, text)
	})
}

// hookGuarded 는 완료 훅 하나를 부르고 그 panic 을 이 잡의 실패로 바꾼다 (FR-ATF-8).
// 훅이 죽어도 finish 는 끝까지 가서 칸을 비운다.
func hookGuarded(st *jobState, final *Job, name string, hook func()) {
	defer func() {
		if v := recover(); v != nil {
			err := panicErr(st, name, v)
			if final.Err == "" {
				final.Err = err.Error()
			}
		}
	}()
	hook()
}

// panicErr 는 잡 안의 panic 을 기록하고 잡의 사유로 쓸 오류로 바꾼다.
func panicErr(st *jobState, where string, v any) error {
	dmlog.Errorf(nil, "git job panic id=%s kind=%s where=%s: %v\n%s", st.job.ID, st.job.Kind, where, v, debug.Stack())
	return fmt.Errorf("%s panic: %v", where, v)
}

// appendLine 은 줄 하나를 보존하고 구독자에게 흘려보낸다.
//
// **자격증명은 저장 전에 지운다** (FR-GIT-104) — 보존분·SSE·기록이 같은 값을
// 보게 되고, 한 곳만 늦게 지우는 경로가 생기지 않는다.
func (j *Jobs) appendLine(st *jobState, stream, text string) {
	text = core.SanitizeRemote(text)
	if text == "" {
		return
	}
	if stream != LineStdout {
		stream = LineStderr
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	if st.job.Done {
		return
	}
	st.seq++
	ln := Line{Seq: st.seq, Stream: stream, Text: text}
	st.lines = append(st.lines, ln)
	// 상한의 두 배에 닿을 때 한 번에 자른다 — 보이는 줄은 visibleLines 가 상한으로
	// 끊는다. 이전: 상한을 넘으면 줄마다 상한만큼 복사했다(잠금 안) (FR-ATF-7, AT-GJB-2).
	if len(st.lines) >= lineTrimFactor*j.lineCap {
		st.lines = append(st.lines[:0], st.lines[len(st.lines)-j.lineCap:]...)
	}
	if stream == LineStderr {
		st.stderr = append(st.stderr, text)
		if len(st.stderr) > core.DefaultStderrTailLines {
			st.stderr = append(st.stderr[:0], st.stderr[len(st.stderr)-core.DefaultStderrTailLines:]...)
		}
	}
	for sub := range st.subs {
		select {
		case sub.ch <- ln:
		default:
			// 느린 구독자 때문에 작업을 멈추지 않는다. 놓친 줄은 보존분에 남으므로
			// after=<seq> 재연결이 되찾는다.
		}
	}
}

// finish 는 작업을 닫는다. 실패의 **사유와 후속 선택지**를 여기서 정한다 —
// 클라이언트가 stderr 를 다시 해석하면 판정이 두 벌이 된다.
func (j *Jobs) finish(st *jobState, exit int, runErr error, dur time.Duration) {
	// 최종 상태는 사본에서 만든다 — st.job 은 잠금 아래에서만 읽히므로 밖에서
	// 쓸 수 없다. 사본이 완성되면 훅을 먼저 부르고, 그 뒤에 한 번의 잠금으로
	// 공개한다.
	j.mu.Lock()
	st.finishing = true
	final := st.job
	canceled := st.canceled
	tail := strings.Join(st.stderr, "\n")
	j.mu.Unlock()

	shutdown := j.root.Err() != nil
	final = classifyOutcome(final, canceled, shutdown, runErr, exit, tail)
	j.recordFinal(st, final, tail, exit, dur)

	// 훅은 **끝이 공개되기 전에** 돈다 (FR-GIT-107). Done 을 세우고 구독자를
	// 닫은 뒤에 부르면, 그 사이에 `done` 을 본 쪽이 status 를 물어 만료되지 않은
	// 캐시를 받는다 — `-race -shuffle` 전량에서 실제로 잡힌 창이다 (M8 P1 ②).
	// ② lock 판정 → ③ 무효화(공용 훅) → ④~⑦ 잡의 완료 처리 (§6.3). ctx 는 루트
	// 파생 + 15s 이며 잡 ctx 와 별개다 — 취소된 잡도 재조회는 해야 한다.
	fctx, fcancel := context.WithTimeout(j.root, core.PostPhaseTimeout)
	defer fcancel()
	if final.ErrorCode == "" && final.Err != "" && core.IndexLockedStderr(tail) {
		final.ErrorCode = ErrorIndexLocked
		if !shutdown {
			final.Lock = j.svc.IndexLockInfo(fctx, final.Repo)
		}
	}
	if j.onDone != nil {
		snapshot := final
		hookGuarded(st, &final, "완료 훅(onDone)", func() { j.onDone(&snapshot) })
	}
	if st.finish != nil {
		hookGuarded(st, &final, "완료 처리(finish)", func() { st.finish(fctx, &final) })
	}

	j.mu.Lock()
	st.job = final
	st.doneAt = j.now()
	j.excl.free(st.keys, SlotsOf(final.Kind), final.ID)
	for sub := range st.subs {
		delete(st.subs, sub)
		sub.close()
	}
	j.mu.Unlock()
	j.changed()
}

// classifyOutcome 은 끝난 작업의 결말을 정한다 — 서버 종료·취소·시한·실행 오류·exit 순의
// 분류와, 원격 kind 에서만의 인증·거부 판정. 부수효과가 없다.
func classifyOutcome(final Job, canceled, shutdown bool, runErr error, exit int, tail string) Job {
	final.Done = true
	final.ExitCode = exit
	final.Canceled = canceled
	final.StderrTail = tail
	remote := remoteKinds[final.Kind]
	switch {
	case shutdown:
		// §8: 서버 종료로 끊긴 것은 사용자의 취소가 아니다 — 최우선 분류다.
		final.Canceled = false
		final.ErrorCode = ErrorServerShutdown
		final.Err = "서버 종료로 중단했다 — 일부가 적용됐을 수 있다"
	case canceled && remote:
		final.Err = "취소했다. 원격에 일부가 적용됐을 수 있다"
	case canceled:
		final.Err = "취소했다. 일부가 적용됐을 수 있다 — 상태를 확인하라"
	case errors.Is(runErr, core.ErrTimeout):
		final.ErrorCode = ErrorTimeout
		final.Err = core.SanitizeRemote(runErr.Error())
	case runErr != nil:
		final.Err = core.SanitizeRemote(runErr.Error())
	case exit != 0:
		// exit 만으로도 실패는 실패다. 사유를 비워 두면 클라이언트가 exitCode 를
		// 직접 해석해야 하고, 그 판정이 두 벌이 된다. 자세한 내용은 StderrTail 이다.
		final.Err = fmt.Sprintf("git %s 가 exit %d 로 끝났다", final.Kind, exit)
	}
	// 원격 전용 판정은 원격 kind 에서만 (§6.3) — merge 의 stderr 에 "rejected" 가
	// 있다고 force push 를 권하지 않는다.
	if !canceled && !shutdown && remote {
		final.AuthRequired = matchesAny(tail, authPatterns)
		final.Rejected = matchesAny(tail, rejectPatterns)
		if final.Rejected {
			final.Options = append([]string(nil), RemoteRejectOptions...)
			final.Fixes = append([]Fix(nil), RemoteRejectFixes...)
		}
	}

	return final
}

// recordFinal 은 끝난 작업을 실행 기록에 남긴다.
func (j *Jobs) recordFinal(st *jobState, final Job, tail string, exit int, dur time.Duration) {
	// 기록은 **지운 argv** 로 남는다 (FR-GIT-104). 파괴적 선언은 호출자가 준
	// spec 을 그대로 옮긴다 (I5).
	//
	// M9_SRS FR-M9-18: **기록도 끝이 공개되기 전에 쓴다.** finish 가 이 뒤에 부르는
	// 훅과 같은 규칙이고 같은 사유다 (FR-GIT-107).
	//
	//   이전 동작: `st.job = final` 로 Done 을 공개한 **뒤**에 기록을 썼다
	//   새  동작: 공개 전에 쓴다
	//   이유:     `done` 을 본 쪽이 곧바로 기록을 물으면 아직 없었다. Console 이
	//             "무엇이 돌았는가" 에 답하는 근거가 그 기록이다 (FR-GXU-1 · D-A-27).
	//             M8 이 훅에서 고친 창을 기록이 그대로 들고 있었고, `-race -shuffle`
	//             이 12회 중 3회 잡았다 (M9 P1 실측)
	var recErr error
	if final.Err != "" {
		recErr = errors.New(final.Err)
	}
	out := core.Output{Stderr: tail, ExitCode: exit, DurationMs: dur.Milliseconds()}
	if st.unguarded != "" {
		// 인가를 건너뛴 실행은 그 표식과 사유로 남는다 (D-A-27) — Console 이 그것으로
		// "왜 화이트리스트를 지나지 않았는가" 에 답한다 (FR-GXU-1).
		j.svc.RecordUnguarded(final.Repo, core.UnguardedSpec{Argv: final.Argv, Reason: st.unguarded}, out, recErr)
	} else {
		j.svc.RecordWrite(final.Repo,
			core.WriteSpec{Argv: final.Argv, Destructive: st.spec.Destructive, Stdin: st.spec.Stdin}, out, recErr)
	}
}

// lineTrimFactor 는 보존 줄을 자르는 시점이다 — 상한의 이 배수에 닿으면 상한으로 자른다.
const lineTrimFactor = 2

// visibleLines 는 밖에 보이는 보존 줄이다 — 마지막 lineCap 줄. 잠금 아래에서 부른다.
func (j *Jobs) visibleLines(st *jobState) []Line {
	if len(st.lines) > j.lineCap {
		return st.lines[len(st.lines)-j.lineCap:]
	}
	return st.lines
}

// sweepLocked 는 보존 기간이 지난 작업을 버린다. 진행 중인 것은 건드리지 않는다.
func (j *Jobs) sweepLocked() {
	now := j.now()
	for id, st := range j.byID {
		if st.job.Done && !now.Before(st.doneAt.Add(j.retention)) {
			delete(j.byID, id)
		}
	}
}

func matchesAny(s string, pats []string) bool {
	low := strings.ToLower(s)
	for _, p := range pats {
		if strings.Contains(low, p) {
			return true
		}
	}
	return false
}
