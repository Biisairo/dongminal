// Package boot는 dongminald 프로세스의 진입점이다. 진입점 판별(`dongminal d`
// 또는 argv[0]=="dongminald")은 composition root 의 책임이라 main 에 남고,
// 여기부터가 데몬 자신의 코드다.
package boot

import (
	"context"
	"dongminal/internal/shared/dmlog"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"os/signal"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/daemon/swap"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/runfile"
	"dongminal/internal/shared/runtime"
	"dongminal/internal/shared/sandboxplace"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/shared/workspace"

	"dongminal/internal/shared/dmenv"
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
//
// handoverFD 가 0 보다 크면 세션 유지 교체로 뜬 것이다. 그 fd 의 인계 상태로 도구와 소켓을
// 되살리고 tools.json 의 빈 셸을 만들지 않는다 (DAEMON_SESSION_KEEP_SRS FR-DSK-20).
func Run(home, version, daemonBuild string, handoverFD int) {
	dmlog.Infof(nil, "dongminald starting home=%s handover=%v", home, handoverFD > 0)

	// FR-PRF-78: **점검만 한다.** 정상 경로에서는 서버가 이미 깔았다 — 데몬은
	// 서버의 자식이다. 없거나 깨졌을 때만 깐다 (사람이 `dongminald` 를 직접 부른
	// 경우가 그 자리다).
	if err := runtime.EnsureInstalled(filepath.Join(home, dmenv.BinDir)); err != nil {
		dmlog.Errorf(nil, "runtime install: %v", err)
		os.Exit(1)
	}

	pm := toolhub.NewToolManager(home, nil)
	// 데몬 모드에서는 PTY 를 데몬이 소유하므로 샌드박스 배치도 여기서 일어난다
	// (FR-SBX-10). 웹서버 쪽 짝은 buildDepsWithHub 의 회수 배선이다.
	//
	// 포트를 넘기지 않으면 주소 파일 → server.json → 기본값으로 정한다
	// (HOT_REBIND_SRS FR-HRB-13). 서버는 포트를 환경변수로 넘기지 않는다 (FR-HRB-11).
	if pl := sandboxplace.Wire(home, version, ""); pl != nil {
		pm.SetPlacer(pl.Place)
	}
	// FR-HLM-3: 헤드리스 멤버의 도구는 Run 이 소유하므로 재시작을 넘긴다.
	// 데몬에는 Run 저장소가 없다 — runs.json 의 주인은 웹서버 프로세스다. 그래서
	// 파일만 읽는 `shared/runfile` 의 술어를 위에서 꽂는다. toolhub 자신은 Run 을 모른 채로
	// 남으며(의존 방향), 이 배선 패키지가 둘을 잇는 자리다.
	pm.SetOwnedTools(func() map[string]struct{} { return runfile.HeadlessToolIDs(home) })

	sockPath := platform.Current().IPC.Endpoint(home)
	pidPath := filepath.Join(home, dmenv.PanedPIDFile)
	// AGENT_RECORD_DAEMON_SRS §3.3a: 서버는 도구의 알람 알림을 건다. 알림은 도구를 만들 때
	// 실리므로 LoadAll 보다 먼저 만든다.
	ps := ipc.NewPanedServer(pm, sockPath, pidPath)

	inherited := readHandover(handoverFD)
	if inherited != nil {
		swap.Restore(pm, ps, *inherited)
	}
	// FR-DSK-26: exec 로 뜬 데몬은 인계 상태로 못 되살린 셸을 되찾거나 입양한다. 쥔 PTY fd 를
	// 닫으면 셸이 끝나므로 버리지 않는다.
	if handoverFD > 0 {
		refs := referencedTools(filepath.Join(home, dmenv.WorkspaceFile))
		if orphans, err := swap.FindOrphans(pm.MasterFDs()); err != nil {
			dmlog.Errorf(nil, "되찾을 셸을 찾지 못했다: %v", err)
		} else if len(orphans) > 0 {
			recovered, adopted := swap.Recover(pm, home, refs, orphans)
			dmlog.Infof(nil, "인계 상태 밖의 셸: 되찾음 %d개, 입양 %d개", recovered, adopted)
		}
	}
	if inherited == nil {
		restoreFromFile(home, pm)
	}

	// VERSION_HEALTH_SRS FR-VHL-1: 이 데몬의 빌드 판을 `hello` 에 싣는다. 값은
	// 이미 `Run(home, version)` 으로 들어와 있다 — 데몬이 `ctl/cli` 를 import
	// 하지 않고도 판을 말할 수 있는 것이 이 주입의 목적이다.
	ps.SetBuildVersion(version)
	// FR-DFP-4: 소켓을 열면서 지문을 남긴다. 자리는 `paned.pid` 의 옆이고 수명도
	// 같다 — 하나는 누가, 하나는 무엇이 도는지다.
	ps.SetDaemonBuild(filepath.Join(home, toolipc.DaemonBuildFile), daemonBuild)
	listen(home, ps, inherited)
	// DAEMON_SESSION_KEEP_SRS: 세션 유지 교체를 받는다. Windows 는 교체기가 거절한다 (D-DSK-7).
	ps.SetReloader(swap.New(swap.Deps{
		Home: home, Tools: pm, Server: ps,
		Env:  swap.Env{EUID: os.Geteuid(), GOOS: string(platform.Current().OS), SelfExe: selfExe()},
		Exec: syscall.Exec,
	}).Reload)

	// PEER_DAEMON_SRS §3.5a: 데몬이 노드다. 노드 소켓은 서버가 노드 포트로 받은 연결을 받는다.
	closeEdge := startEdge(home, ps, pm)

	// On signal, close the listener to unblock Accept() and save state.
	ctx, stop := signal.NotifyContext(context.Background(), platform.Current().Process.ShutdownSignals()...)
	defer stop()

	go func() {
		<-ctx.Done()
		closeEdge()
		ps.Close()
	}()

	// FR-OPT-2-1: 전경 조회는 PTY 를 가진 이 프로세스가 스스로 돌리고 바뀐 것만
	// push 한다. 서버는 이 데몬(fgtick)에 전경용 list 폴을 보내지 않는다.
	fgTick := time.NewTicker(toolhub.ForegroundRefreshInterval)
	defer fgTick.Stop()
	pm.StartForegroundRefresh(ctx.Done(), fgTick.C)
	// FR-ARD-30: 유휴 판정도 데몬이 한다. 문턱은 서버의 attnconfig 가 바꿀 수 있으므로
	// 지금 0 이어도 돌린다.
	attnTick := time.NewTicker(toolhub.AttentionSweepInterval)
	defer attnTick.Stop()
	pm.RunAttentionSweeper(ctx.Done(), attnTick.C)

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

// readHandover 는 교체로 넘겨받은 인계 상태다. 일반 기동이거나 읽지 못하면 nil 이다.
func readHandover(fd int) *swap.State {
	if fd <= 0 {
		return nil
	}
	st, err := swap.ReadState(os.NewFile(uintptr(fd), "handover"))
	if err != nil {
		dmlog.Errorf(nil, "인계 상태를 읽지 못했다 — 일반 기동으로 간다: %v", err)
		return nil
	}
	return &st
}

// restoreFromFile 은 일반 기동의 복원이다 — tools.json 에서 탭이 가리키는 도구를 빈 셸로 되살린다.
func restoreFromFile(home string, pm *toolhub.ToolManager) {
	refs := referencedTools(filepath.Join(home, dmenv.WorkspaceFile))
	headless := runfile.HeadlessToolIDs(home)
	for id := range headless {
		refs[id] = struct{}{}
	}
	// 되찾은 셸(FR-DSK-27)은 이미 있다. 같은 id 로 빈 셸을 만들면 그 도구를 덮는다.
	for id := range refs {
		if pm.Get(id) != nil {
			delete(refs, id)
		}
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
}

// listen 은 두 소켓을 연다. 인계 상태가 있으면 넘겨받은 리스너를 쓰고, 못 쓰면 새로 연다
// (FR-DSK-24).
func listen(home string, ps *ipc.PanedServer, inherited *swap.State) {
	reportPath := agentrec.SocketPath(home)
	if inherited != nil {
		paned, report, err := swap.InheritListeners(*inherited)
		if err == nil {
			ps.ListenInherited(paned, report, reportPath)
			go ps.ServeReports()
			return
		}
		dmlog.Errorf(nil, "넘겨받은 소켓을 쓰지 못했다 — 새로 연다: %v", err)
	}
	// FR-DSK-26: exec 로 넘어왔으나 쓰지 못한 리스너가 남아 있으면 Listen 의 안전 검사가 그
	// 소켓에 붙어 "다른 데몬이 있다" 로 보고 끝난다. 그 fd 를 먼저 닫는다.
	if n := swap.CloseInheritedSockets(platform.Current().IPC.Endpoint(home), reportPath); n > 0 {
		dmlog.Warnf(nil, "쓰지 못한 물려받은 소켓 fd %d개를 닫았다", n)
	}
	if err := ps.Listen(); err != nil {
		dmlog.Errorf(nil, "dongminald listen: %v", err)
		os.Exit(1)
	}
	// AGENT_RECORD_DAEMON_SRS FR-ARD-20: 훅 보고는 따로 연 소켓으로 받는다. 열지 못해도
	// 기동은 막지 않는다 — dmctl 이 HTTP 로 보낸다 (FR-ARD-23).
	if err := ps.ListenReports(reportPath); err != nil {
		dmlog.Errorf(nil, "dongminald 보고 소켓: %v", err)
	} else {
		go ps.ServeReports()
	}
}

// selfExe 는 이 데몬의 실행 파일(심볼릭 링크를 푼 경로)이다. 모르면 빈 값이고, 그때 교체기는
// 모든 요청을 거절한다 (DAEMON_SESSION_KEEP_SRS FR-DSK-11).
func selfExe() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return ""
	}
	return resolved
}
