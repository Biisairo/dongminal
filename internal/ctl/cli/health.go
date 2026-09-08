package cli

import (
	"fmt"
	"io"
	"path/filepath"
	"time"

	"dongminal/internal/helper/runtimebin"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/runtime"
)

// healthPingTimeout 은 HTTP 생존 확인의 대기다. 사람이 결과를 기다리는 명령이므로
// 짧다 — 떠 있으면 즉시 답하고, 떠 있지 않으면 재시도해도 답하지 않는다.
const healthPingTimeout = 3 * time.Second

// RunHealth는 `dongminal health` 다 (FR-ACT-9/10).
func RunHealth(o HealthOpts, stdout, stderr io.Writer) int {
	home, err := o.ResolveHome()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	port := o.ResolvePort()

	fail := 0
	// 호스트는 `dmenv.DefaultHost` 다 (FR-DRC-12). 여기만 "localhost" 를 박아
	// 두었더니 그 이름이 `::1` 로 먼저 풀리는 환경에서 health 만 실패했다 —
	// 서버는 `127.0.0.1` 에 떠 있고, 옆의 `migrate.go` 는 이미 이 상수를 쓴다.
	// 같은 데몬을 두 이름으로 부르면 한쪽이 다른 인스턴스를 본다 (dmenv.go:40).
	if ping(fmt.Sprintf("http://%s:%s/", dmenv.DefaultHost, port), healthPingTimeout) {
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

	// HELPER_INSTALL_SRS FR-HLI-9: 설치된 헬퍼가 죽어 있어도 서버와 데몬은
	// 멀쩡하다 — 그래서 지금까지 아무도 알려 주지 않았고, 에이전트 훅이 실패할
	// 때에야 드러났다. 기동은 이것을 스스로 고치지만(§2.4), **다시 띄우기 전에**
	// 아는 수단이 필요하다.
	binDir := filepath.Join(home, "bin")
	switch st := runtime.InspectHelpers(binDir); {
	case !st.Installed:
		// 아직 기동 전인 홈이다. 소켓 부재를 실패로 세지 않는 것과 같은 이유다.
		fmt.Fprintf(stdout, "ℹ️  헬퍼 %s (%s)\n", runtime.HelperNotInstalled, binDir)
	case len(st.Problems) > 0:
		for _, b := range st.Problems {
			fmt.Fprintf(stdout, "❌ 헬퍼 %s — %s\n", b.Path, b.Reason)
		}
		fmt.Fprintf(stdout, "   %s\n", runtime.HelperFixHint)
		fail += len(st.Problems)
	default:
		fmt.Fprintf(stdout, "✅ 헬퍼 %d개 실행 가능 (%s)\n", len(runtimebin.HelperNames()), binDir)
	}

	if fail > 0 {
		return 1
	}
	return 0
}
