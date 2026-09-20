package cli

import (
	"fmt"
	"io"
	"path/filepath"
	"time"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/runtime"
)

// healthPingTimeout 은 HTTP 생존 확인의 대기다. 사람이 결과를 기다리는 명령이므로
// 짧다 — 떠 있으면 즉시 답하고, 떠 있지 않으면 재시도해도 답하지 않는다.
const healthPingTimeout = 3 * time.Second

// RunHealth는 `dongminal health` 다 (FR-ACT-9/10).
func RunHealth(o HealthOpts, stdout, stderr io.Writer) int {
	tgt, err := o.ResolveTarget()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	tgt.warn(stderr)
	home := tgt.Home
	// FR-DFP-7: 데몬의 낡음만 묻는 갈래. HTTP 도 헬퍼도 보지 않으므로 서버가
	// 떠 있지 않아도 즉시 답한다.
	if o.DaemonOnly {
		fmt.Fprintln(stdout, daemonStateLine(inspectDaemon(home)))
		return 0
	}
	port := tgt.Port

	fail := 0
	// 호스트는 **겨냥 해석이 준 것**이다 (FR-STR-22·24).
	//
	//   이전 동작: `dmenv.DefaultHost` 고정. `localhost` 를 박아 두었더니 그 이름이
	//             `::1` 로 먼저 풀리는 환경에서 health 만 실패했고(FR-DRC-12),
	//             그 수정이 **과교정이었다** — `DONGMINAL_HOST=192.168.1.5` 로
	//             띄운 인스턴스에 health 를 걸면 언제나 실패한다.
	//   새  동작: `ResolveTarget` 이 준 host·port. 옆의 `start` 와 같은 규칙이다.
	//   이유:     `DialHost` 가 그 이름 해석 문제를 이미 푼다 — 미지정 주소만
	//             loopback 으로 바꾸고 나머지는 그대로 두드린다. 두 벌로 두면
	//             한쪽만 고쳐진다.
	if ping(tgt.URL+"/", healthPingTimeout) {
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

	// FR-DFP-10: 낡은 데몬은 **어긋남이지 고장이 아니다.** 그래서 말하되 `fail`
	// 에 세지 않는다 — 이 명령의 종료 코드는 생존의 답이고, 그것을 바꾸면
	// 되살릴 것이 없는데도 스크립트가 실패로 읽는다.
	fmt.Fprintf(stdout, "%s\n", daemonStateLine(inspectDaemon(home)))

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
		fmt.Fprintf(stdout, "✅ 헬퍼 %d개 실행 가능 (%s)\n", len(dmenv.HelperNames()), binDir)
	}

	if fail > 0 {
		return 1
	}
	return 0
}
