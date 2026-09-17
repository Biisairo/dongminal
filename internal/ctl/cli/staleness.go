package cli

import (
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/shared/toolipc"
)

// DaemonBuild 는 이 바이너리 안의 **데몬 코드**의 지문이다
// (DAEMON_STALENESS_SRS FR-DFP-1). 빌드 때 새겨진다:
//
//	go build -ldflags "-X dongminal/internal/ctl/cli.DaemonBuild=<지문>" ./cmd/dongminal
//
// `Version` 과 **다른 것을 센다.** 빌드 판은 릴리스마다 바뀌고 로컬 빌드에서는
// 언제나 `dev` 라, 판이 가장 자주 갈리는 자리에서 침묵한다(§2.2). 이 값은 데몬
// 프로세스가 실행하는 코드에서만 나오므로 웹서버만 고친 빌드에서는 바뀌지 않는다.
//
// 새기지 않으면 빈 값이다 — **모른다**이며 불일치가 아니다 (FR-DFP-3).
var DaemonBuild = ""

// DaemonState 는 "지금 도는 데몬이 이 바이너리의 코드인가" 의 답이다 (FR-DFP-8).
type DaemonState int

const (
	// DaemonUnknown 은 지문이 한쪽이라도 비어 판정할 수 없는 상태다.
	// **일치로 접지 않는다** — 낡은 데몬 위에서 고친 줄 알았던 버그를 다시 보는
	// 것이 이 판정이 없애려는 값이고, 그것은 침묵으로 되돌아온다.
	DaemonUnknown DaemonState = iota
	DaemonNotRunning
	DaemonFresh
	DaemonStale
)

// classifyDaemon 은 판정의 전부다. 재료 셋만 받는다 — 파일도 소켓도 여기서는
// 만지지 않으므로 네 상태를 그대로 잴 수 있다.
func classifyDaemon(alive bool, recorded, current string) DaemonState {
	if !alive {
		return DaemonNotRunning
	}
	if recorded == "" || current == "" {
		return DaemonUnknown
	}
	if recorded == current {
		return DaemonFresh
	}
	return DaemonStale
}

// inspectDaemon 은 홈을 보고 판정한다. 파일 둘만 읽는다 — 소켓에 붙지 않는
// 것이 계약이다 (NFR-DFP-2): 데몬이 멎어 응답하지 않는 때가 판정이 가장
// 필요한 때다.
func inspectDaemon(home string) DaemonState {
	_, alive := daemonPID(home)
	return classifyDaemon(alive, recordedDaemonBuild(home), DaemonBuild)
}

// recordedDaemonBuild 는 도는 데몬이 남긴 지문이다. 없으면 빈 값 — 없음은
// 모른다이지 일치가 아니다.
func recordedDaemonBuild(home string) string {
	blob, err := os.ReadFile(filepath.Join(home, toolipc.DaemonBuildFile))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(blob))
}

// daemonStateLine 은 그 상태를 사람에게 말하는 **유일한** 자리다 (FR-DFP-11).
// 세 호출자(`build.sh`·`start`·`health`)가 이것을 부른다 — 세 벌로 적으면 한 곳만
// 고쳐지고, 그때 세 출력이 서로를 반박한다.
func daemonStateLine(s DaemonState) string {
	switch s {
	case DaemonNotRunning:
		return "ℹ️  dongminald 미실행 — dongminal start 가 새 바이너리로 기동합니다"
	case DaemonFresh:
		return "✅ 데몬 코드 그대로 — dongminal start 만 하면 됩니다 (세션 보존)"
	case DaemonStale:
		return "⚠️  데몬 코드가 바뀌었습니다 — dongminal start --restart-daemon (터미널 세션을 잃습니다)"
	default:
		return "ℹ️  데몬 판을 모릅니다 — 반영을 확실히 하려면 dongminal start --restart-daemon"
	}
}

// runningDaemonNotice 는 기동이 데몬에 대해 말하는 것이다 (FR-DFP-9).
//
// 소켓의 존재를 **인자로** 받는 이유는 이 함수가 판정만 하고 관측은 하지 않게
// 하기 위해서다 — 종단의 모양은 플랫폼마다 다르고(유닉스는 파일, 윈도우는
// named pipe) 그 앎은 `platform` 의 것이다 (FR-XPL-5 와 같은 근거).
func runningDaemonNotice(home string, running bool) string {
	if !running {
		return "dongminald 미실행 — dongminal 이 자동 기동합니다"
	}
	line := "dongminald 실행 중 (세션 보존)"
	// 낡음만 덧댄다. 일치를 다시 말하면 기동 출력이 길어지기만 하고, 모른다는
	// 기동이 답할 수 있는 것이 아니다 — 그 자리는 `build.sh` 와 `health` 다.
	if inspectDaemon(home) == DaemonStale {
		line += "\n" + daemonStateLine(DaemonStale)
	}
	return line
}
