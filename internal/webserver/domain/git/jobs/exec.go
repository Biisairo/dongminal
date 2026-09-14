package jobs

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/platform"
	"dongminal/internal/webserver/domain/git/core"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `job.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **프로세스를 띄우고 줄을 흘리는 일**이다 — git 실행, 스트림 읽기,
// 종료 대기. `job.go` 에 남은 것은 작업의 **수명과 구독**이며, 실행기를 갈아 끼워도
// (`WithJobRunner`) 그 수명은 바뀌지 않는다.

// execStreamGit 은 작업 경로의 기본 실행이다.
func execStreamGit(ctx context.Context, dir string, args []string, emit func(stream, text string)) (int, error) {
	bin, err := exec.LookPath("git")
	if err != nil {
		return -1, fmt.Errorf("%w: %v", core.ErrGitMissing, err)
	}
	return execStream(ctx, dir, bin, args, emit)
}

// execStream 은 프로세스를 **자기 프로세스 그룹**에 띄우고 줄 단위로 읽는다.
//
// 그룹으로 띄우는 이유는 취소다 (FR-GIT-102): git 이 띄운 ssh·git-remote-https 가
// 남으면 취소가 취소가 아니다. 취소는 그룹 전체에 SIGTERM 이고, 유예를 넘기면
// SIGKILL 로 올린다.
//
// StdoutPipe 대신 os.Pipe 를 쓰는 이유는 Wait 의 의미다 — StdoutPipe 는 파이프가
// 닫히기를 기다리므로, 파이프를 잡은 자식이 남으면 Wait 가 돌아오지 않는다.
//
// bin 을 인자로 받는 이유는 이 경로 자체를 git 없이 검증할 수 있어야 하기
// 때문이다. 실제 호출자는 execStreamGit 뿐이다.
func execStream(ctx context.Context, dir, bin string, args []string, emit func(stream, text string)) (int, error) {
	outR, outW, err := os.Pipe()
	if err != nil {
		return -1, err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		return -1, err
	}

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	cmd.Stdout = outW
	cmd.Stderr = errW
	cmd.Env = core.Env()
	group := platform.Current().Process.NewGroup(cmd)
	defer group.Close()
	cmd.Cancel = group.Terminate
	cmd.WaitDelay = JobKillGrace

	if serr := cmd.Start(); serr != nil {
		outR.Close()
		outW.Close()
		errR.Close()
		errW.Close()
		return -1, fmt.Errorf("%s %s: %w", filepath.Base(bin), strings.Join(args, " "), serr)
	}
	// 묶음에 넣고 자식을 놓아준다. 이것을 건너뛰면 Windows 에서 자식이 중단된
	// 채로 남아 영영 시작되지 않는다 (CROSS_PLATFORM_SRS FR-XPR-5).
	if berr := group.Bind(); berr != nil {
		_ = group.Kill()
		outR.Close()
		outW.Close()
		errR.Close()
		errW.Close()
		_ = cmd.Wait()
		return -1, fmt.Errorf("%s %s: %w", filepath.Base(bin), strings.Join(args, " "), berr)
	}
	// 부모 쪽 쓰기단을 닫는다 — 닫지 않으면 자식이 끝나도 읽기가 EOF 를 못 본다.
	outW.Close()
	errW.Close()

	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); defer outR.Close(); readLines(outR, func(t string) { emit(LineStdout, t) }) }()
	go func() { defer wg.Done(); defer errR.Close(); readLines(errR, func(t string) { emit(LineStderr, t) }) }()
	read := make(chan struct{})
	go func() { wg.Wait(); close(read) }()

	waitErr := cmd.Wait()
	// 리더가 끝났어도 그룹에 남은 자식이 파이프를 잡고 있을 수 있다. 유예까지
	// 기다린 뒤 그룹을 쓸어낸다 — 작업이 영원히 끝나지 않는 것보다 낫다.
	if !waitFor(read, JobKillGrace) {
		group.Kill()
		waitFor(read, JobKillGrace)
	}

	exit := -1
	if cmd.ProcessState != nil {
		exit = cmd.ProcessState.ExitCode()
	}
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return exit, fmt.Errorf("%w: git %s 가 상한을 넘겨 종료됐다", core.ErrTimeout, strings.Join(args, " "))
	case ctx.Err() != nil:
		// 취소다. 사유는 호출자가 안다 — 여기서 오류로 올리면 취소가 실패로 보인다.
		return exit, nil
	case waitErr != nil && exit <= 0:
		return exit, fmt.Errorf("%s %s: %w", filepath.Base(bin), strings.Join(args, " "), waitErr)
	}
	return exit, nil
}

func waitFor(done <-chan struct{}, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-done:
		return true
	case <-t.C:
		return false
	}
}

// readLines 는 r 을 줄 단위로 읽어 emit 한다. **`\r` 과 `\n` 모두가 줄 끝이다** —
// git 의 진행 표시는 `\r` 로 같은 줄을 덮으므로, `\n` 만 보는 분할은 진행을
// 통째로 놓친다 (FR-GIT-103).
//
// 빈 줄은 내보내지 않는다. CRLF 가 두 줄로 세지는 것을 막고, 진행 표시에 빈 줄이
// 끼어들지 않게 한다.
//
// 상한을 넘긴 줄은 상한에서 끊어 내보낸다 — 구분자 없는 스트림 하나가 메모리를
// 삼키거나 읽기를 멈추게 하지 않는다.
func readLines(r io.Reader, emit func(string)) {
	br := bufio.NewReaderSize(r, JobLineMax)
	buf := make([]byte, 0, JobLineMax)
	flush := func() {
		if len(buf) > 0 {
			emit(string(buf))
			buf = buf[:0]
		}
	}
	for {
		b, err := br.ReadByte()
		if err != nil {
			flush()
			return
		}
		if b == '\n' || b == '\r' {
			flush()
			continue
		}
		buf = append(buf, b)
		if len(buf) >= JobLineMax {
			flush()
		}
	}
}
