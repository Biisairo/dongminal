// Package boot는 dongminald 프로세스의 진입점이다. 진입점 판별(`dongminal d`
// 또는 argv[0]=="dongminald")은 composition root 의 책임이라 main 에 남고,
// 여기부터가 데몬 자신의 코드다.
package boot

import (
	"context"
	"dongminal/internal/shared/dmlog"
	"os"
	"path/filepath"

	"os/signal"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/runfile"
	"dongminal/internal/shared/runtime"
	"dongminal/internal/shared/sandboxplace"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/shared/workspace"

	"dongminal/internal/shared/platform"
)

// referencedTools reads workspace.json and returns the tool ids its tabs point
// at (FR-EM-14). A missing file yields an empty set — nothing to restore. A
// parse/schema failure also yields an empty set after logging: respawning
// unreachable shells is worse than starting empty, and the schema gate in the
// web server will tell the user to migrate.
func referencedTools(path string) map[string]struct{} {
	blob, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			dmlog.Infof(nil, "workspace 읽기: %v", err)
		}
		return map[string]struct{}{}
	}
	refs, err := workspace.ReferencedToolIDs(blob)
	if err != nil {
		dmlog.Errorf(nil, "workspace 참조 해석 실패 — 도구를 복원하지 않습니다: %v", err)
		return map[string]struct{}{}
	}
	return refs
}

// Run is the entry point for dongminald (DAEMON_SPLIT_SRS Phase 2).
// It creates a ToolManager, loads tools.json, and listens on a Unix socket.
//
// version 은 이 바이너리의 판이다(cli.Version). 인자로 받는 것은 데몬이
// ctl/cli 를 되받아 import 하지 않게 하기 위해서다 — 샌드박스 헬퍼를 서버와
// 같은 판으로 맞추는 데만 쓰인다 (FR-SBX-14).
//
// daemonBuild 는 이 바이너리 안 **데몬 코드**의 지문이다(cli.DaemonBuild). 같은
// 이유로 주입받으며, 기동이 그것을 홈에 남겨 "지금 도는 것이 무엇인가" 에
// 답한다 (DAEMON_STALENESS_SRS FR-DFP-4/6).
func Run(home, version, daemonBuild string) {
	dmlog.Infof(nil, "dongminald starting home=%s", home)

	// FR-PRF-78: **점검만 한다.** 정상 경로에서는 서버가 이미 깔았다 — 데몬은
	// 서버의 자식이다. 없거나 깨졌을 때만 깐다 (사람이 `dongminald` 를 직접 부른
	// 경우가 그 자리다).
	if err := runtime.EnsureInstalled(filepath.Join(home, "bin")); err != nil {
		dmlog.Errorf(nil, "runtime install: %v", err)
		os.Exit(1)
	}

	pm := toolhub.NewToolManager(home, nil)
	// 데몬 모드에서는 PTY 를 데몬이 소유하므로 샌드박스 배치도 여기서 일어난다
	// (FR-SBX-10). 웹서버 쪽 짝은 buildDepsWithHub 의 회수 배선이다.
	//
	// 포트를 넘기지 않는 것은 데몬이 그것을 환경으로 물려받기 때문이다 — 서버가
	// 심는 값이 진실이고, 데몬이 따로 기억하면 두 벌이 된다.
	if pl := sandboxplace.Wire(home, version, ""); pl != nil {
		pm.SetPlacer(pl.Place)
	}
	// FR-HLM-3: 헤드리스 멤버의 도구는 Run 이 소유하므로 재시작을 넘긴다.
	// 데몬에는 Run 저장소가 없다 — runs.json 의 주인은 웹서버 프로세스다. 그래서
	// 파일만 읽는 `shared/runfile` 의 술어를 위에서 꽂는다. toolhub 자신은 Run 을 모른 채로
	// 남으며(의존 방향), 이 배선 패키지가 둘을 잇는 자리다.
	pm.SetOwnedTools(func() map[string]struct{} { return runfile.HeadlessToolIDs(home) })
	refs := referencedTools(filepath.Join(home, "workspace.json"))
	headless := runfile.HeadlessToolIDs(home)
	for id := range headless {
		refs[id] = struct{}{}
	}
	pm.LoadAll(refs)
	// 백그라운드 등록은 런타임 상태라 tools.json 에 없다. 되돌리지 않으면 탭에도
	// ⏻ 목록에도 없는, 어디서도 닿을 수 없는 도구가 된다 (FR-BGR-5 와 같은 이유).
	for id := range headless {
		pm.SetBackground(id, true)
	}
	if len(headless) > 0 {
		dmlog.Infof(nil, "헤드리스 도구 %d개를 백그라운드로 복원", len(headless))
	}

	sockPath := platform.Current().IPC.Endpoint(home)
	pidPath := filepath.Join(home, "paned.pid")

	ps := ipc.NewPanedServer(pm, sockPath, pidPath)
	// VERSION_HEALTH_SRS FR-VHL-1: 이 데몬의 빌드 판을 `hello` 에 싣는다. 값은
	// 이미 `Run(home, version)` 으로 들어와 있다 — 데몬이 `ctl/cli` 를 import
	// 하지 않고도 판을 말할 수 있는 것이 이 주입의 목적이다.
	ps.SetBuildVersion(version)
	// FR-DFP-4: 소켓을 열면서 지문을 남긴다. 자리는 `paned.pid` 의 옆이고 수명도
	// 같다 — 하나는 누가, 하나는 무엇이 도는지다.
	ps.SetDaemonBuild(filepath.Join(home, toolipc.DaemonBuildFile), daemonBuild)
	if err := ps.Listen(); err != nil {
		dmlog.Errorf(nil, "dongminald listen: %v", err)
		os.Exit(1)
	}

	// On signal, close the listener to unblock Accept() and save state.
	ctx, stop := signal.NotifyContext(context.Background(), platform.Current().Process.ShutdownSignals()...)
	defer stop()

	go func() {
		<-ctx.Done()
		ps.Close()
	}()

	dmlog.Infof(nil, "dongminald listening on %s (platform=%s)", sockPath, platform.Current().OS)

	// Accept loop. Each connection is handled serially; when it drops,
	// the daemon waits for the next dongminal to connect.
	for {
		if err := ps.Accept(); err != nil {
			select {
			case <-ctx.Done():
				dmlog.Infof(nil, "dongminald shutting down, saving %d tools...", len(pm.Snapshot()))
				// 문을 닫고 인플라이트 저장을 거둔 뒤에 마지막 상태를 쓴다.
				// 그러지 않으면 프로세스가 쓰기 도중에 끝나 tools.json 이
				// 잘릴 수 있다.
				pm.StopSaving()
				pm.SaveAll()
				return
			default:
			}
			dmlog.Infof(nil, "dongminald accept: %v", err)
			// Continue accepting — transient errors are not fatal.
		}
	}
}
