package cli

import (
	"fmt"
	"io"
)

// RunStop은 `dongminal stop` 이다 (FR-ACT-5..8).
func RunStop(o StopOpts, stdout, stderr io.Writer) int {
	// **겨냥이 이 명령에서 가장 값이 크다** (FR-STR-23·25).
	//
	//   이전 동작: `ResolvePort()` 의 3계층. `server.json` 에 포트를 적어 둔
	//             사용자에게 이 명령은 기본 포트를 겨눴고, `killPort` 는 대상을
	//             가리지 않으므로 **그 포트의 남의 프로세스에 TERM→KILL 을 보냈다.**
	//   새  동작: `ResolveTarget` 의 4계층.
	//   이유:     FR-CFG-13. 죽이는 대상이 `start` 가 띄운 것과 같아야 한다.
	tgt, err := o.ResolveTarget()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	tgt.warn(stderr)
	home, port := tgt.Home, tgt.Port

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
