package cli

import (
	"fmt"
	"io"
)

// RunStop은 `dongminal stop` 이다 (FR-ACT-5..8).
func RunStop(o StopOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	port := o.ResolvePort()

	ok := true
	if len(pidsOnPort(port)) == 0 {
		fmt.Fprintf(stdout, "dongminal 미실행 (포트 %s)\n", port)
	} else if killPort(port, stdout, "dongminal") {
		fmt.Fprintln(stdout, "✅ dongminal 정지")
	} else {
		fmt.Fprintln(stderr, "❌ dongminal 정지 실패")
		ok = false
	}

	if o.All {
		if stopDaemon(home, stdout) {
			fmt.Fprintln(stdout, "✅ dongminald 정지")
		} else {
			fmt.Fprintln(stderr, "❌ dongminald 정지 실패")
			ok = false
		}
	} else if pid, alive := daemonPID(home); alive {
		fmt.Fprintf(stdout, "dongminald 실행 유지 pid=%d (세션 보존)\n", pid)
	}

	if !ok {
		return 1
	}
	return 0
}
