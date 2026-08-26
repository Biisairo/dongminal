package cli

import (
	"fmt"
	"io"
	"time"
)

// RunHealth는 `dongminal health` 다 (FR-ACT-9/10).
func RunHealth(o HealthOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	port := o.ResolvePort()

	fail := 0
	if ping(fmt.Sprintf("http://localhost:%s/", port), 3*time.Second) {
		fmt.Fprintf(stdout, "✅ dongminal HTTP :%s\n", port)
	} else {
		fmt.Fprintf(stdout, "❌ dongminal HTTP :%s — 응답 없음\n", port)
		fail++
	}

	switch pid, alive := daemonPID(home); {
	case !socketExists(home):
		// 소켓 부재는 실패가 아니다 — direct mode 이거나 아직 기동 전이다.
		fmt.Fprintln(stdout, "ℹ️  dongminald 소켓 없음 (direct mode 이거나 미기동)")
	case alive:
		fmt.Fprintf(stdout, "✅ dongminald pid=%d socket=%s/%s\n", pid, home, daemonSockFile)
	case pid > 0:
		fmt.Fprintf(stdout, "⚠️  dongminald 소켓은 있으나 pid=%d 가 죽어 있습니다\n", pid)
		fail++
	default:
		fmt.Fprintln(stdout, "ℹ️  dongminald 소켓은 있으나 pidfile 이 없습니다")
	}

	if fail > 0 {
		return 1
	}
	return 0
}
