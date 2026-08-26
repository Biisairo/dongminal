package cli

import (
	"errors"
	"fmt"
	"io"
)

// Dispatch는 액션을 해석해 실행한다 (FR-CLI-1..7).
//
// args 는 프로그램 이름을 뺀 인자다. serve 는 `start --foreground` 가 쓰는
// 서버 실행 콜백이다.
func Dispatch(args []string, serve Serve, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stdout, Help())
		return 0
	}
	action, rest := args[0], args[1:]
	switch action {
	case "-h", "--help", "help":
		fmt.Fprint(stdout, Help())
		return 0
	case "start":
		o, err := ParseStart(rest)
		if code, done := settle(action, err, stdout, stderr); done {
			return code
		}
		return RunStart(o, serve, stdout, stderr)
	case "stop":
		o, err := ParseStop(rest)
		if code, done := settle(action, err, stdout, stderr); done {
			return code
		}
		return RunStop(o, stdout, stderr)
	case "health":
		o, err := ParseHealth(rest)
		if code, done := settle(action, err, stdout, stderr); done {
			return code
		}
		return RunHealth(o, stdout, stderr)
	case "migrate":
		o, err := ParseMigrate(rest)
		if code, done := settle(action, err, stdout, stderr); done {
			return code
		}
		return RunMigrate(o, stdout, stderr)
	}
	fmt.Fprint(stderr, UnknownAction(action))
	return 2
}

// settle은 파서의 결과를 종료 코드로 바꾼다. done 이 true 면 액션을 실행하지
// 않는다 — help 요청이거나 옵션 오류다 (FR-CLI-6/7).
func settle(action string, err error, stdout, stderr io.Writer) (int, bool) {
	switch {
	case err == nil:
		return 0, false
	case errors.Is(err, ErrHelp):
		fmt.Fprint(stdout, Usage(action))
		return 0, true
	default:
		fmt.Fprintln(stderr, err)
		return 2, true
	}
}
