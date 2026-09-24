package jobs

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"

	"dongminal/internal/webserver/domain/git/core"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `job.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **프로세스를 띄우고 줄을 흘리는 일**이다 — git 실행, 스트림 읽기,
// 종료 대기. `job.go` 에 남은 것은 작업의 **수명과 구독**이며, 실행기를 갈아 끼워도
// (`WithJobRunner`) 그 수명은 바뀌지 않는다.

// execStreamGit 은 작업 경로의 기본 실행이다.
func execStreamGit(ctx context.Context, dir string, args []string, stdin string, emit func(stream, text string)) (int, error) {
	bin, err := exec.LookPath("git")
	if err != nil {
		return -1, fmt.Errorf("%w: %v", core.ErrGitMissing, err)
	}
	return execStream(ctx, dir, bin, args, stdin, emit)
}

// execStream 은 프로세스를 core 기동 헬퍼로 띄우고 줄 단위로 읽는다.
//
// 그룹·신호 시퀀스(취소 시 그룹 SIGTERM → 유예 → KILL, 파이프를 쥔 자식 정리)는
// 동기 실행과 **같은 자리**(core.Spawn)가 갖는다 (REPO_FIX 01 P-1). 종전에는 이
// 파일이 따로 가졌고 동기 실행에는 없어서 훅 고아·index.lock 잔존이 생겼다.
//
// bin 을 인자로 받는 이유는 이 경로 자체를 git 없이 검증할 수 있어야 하기
// 때문이다. 실제 호출자는 execStreamGit 뿐이다.
func execStream(ctx context.Context, dir, bin string, args []string, stdin string, emit func(stream, text string)) (int, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	// 빈 stdin 에 파이프를 만들지 않는다 (§6.2) — 커밋 메시지만 이 길로 온다.
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	cmd.Env = core.Env()
	waitErr := core.Spawn(ctx, cmd,
		func(r io.Reader) { readLines(r, func(t string) { emit(LineStdout, t) }) },
		func(r io.Reader) { readLines(r, func(t string) { emit(LineStderr, t) }) })

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
