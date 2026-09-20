package main

import (
	"context"
	"errors"
	"os/signal"
	"path/filepath"
	"time"

	"dongminal/internal/ctl/cli"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
	"dongminal/internal/shared/runtime"
	"dongminal/internal/shared/serverconf"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/updatecheck"
	"dongminal/internal/shared/workspace"
	"dongminal/internal/webserver/httpapi"
	"dongminal/internal/webserver/hub"
	"dongminal/internal/webserver/toolclient"
	"dongminal/web"

	"os"
)

// app 은 서버 프로세스 하나의 조립·기동·종료다 (M8 D-A-12, GO-16). 종전의 `serve`
// 한 함수가 셋을 한 자리에서 했고 종료 순서는 주석이었다 — 이제 순서는
// `shutdownSteps` 의 표이고 테스트가 그 이름 순서를 잰다.
type app struct {
	home, host, port string
	panedClient      *toolclient.ToolClient
	bd               builtDeps
	srv              *httpapi.Server
	// updates 는 최신 판 캐시다 (UPDATE_NOTICE_SRS). 조립에서 만들고 run 이
	// 시작하며 종료 표가 멈춘다 — 시계를 가진 다른 것들과 같은 수명이다.
	updates *updatecheck.Checker
}

// buildApp 은 조립이다 — 로그 계층·헬퍼 설치·데몬 연결·의존 배선·서버·해석층
// 되살림. 여기서 돌아오면 요청을 받을 수 있는 상태이며 아직 아무것도 돌지 않는다.
func buildApp(home, host, port string) (*app, error) {
	os.Setenv(dmenv.EnvHome, home)
	// helper multi-call(dmctl/edit/…)이 서버 주소를 찾는 값이다.
	os.Setenv(dmenv.EnvPort, port)
	os.Setenv(dmenv.EnvHost, host)

	// CONFIG_MANAGEMENT_SRS FR-CFG-13: 홈이 정해졌으므로 이제 파일 계층까지
	// 읽어 로그 수준을 다시 세운다. `main` 의 첫 Init 은 환경변수까지만 봤다.
	conf := serverconf.Resolve(serverconf.Inputs{Home: home})
	for _, w := range conf.Warnings {
		dmlog.Warnf(nil, "%s", w)
	}
	dmlog.Init(dmlog.Options{Level: conf.LogLevel.Value})

	if err := runtime.Install(filepath.Join(home, "bin")); err != nil {
		return nil, errors.Join(errRuntimeInstall, err)
	}

	// FR-VHL-10: 서버의 빌드 판을 헬스가 쓴다. 데몬은 `boot.Run(home, cli.Version)`
	// 으로 같은 값을 받는다 — 둘이 같은 출처를 봐야 불일치 판정이 뜻을 갖는다.
	cfg := httpapi.Config{Port: port, DataDir: home, StaticFS: web.FS(), Version: cli.Version}

	a := &app{home: home, host: host, port: port}
	// Try daemon mode: connect to dongminald if available
	a.panedClient = dialOrStartDaemon(home)

	var err error
	if a.panedClient != nil {
		// Daemon mode: ToolClient implements ToolHub
		a.bd, err = buildDepsWithHub(cfg, a.panedClient)
		if err == nil {
			a.wireDaemonPushes()
		}
	} else {
		// Direct mode: ToolManager directly (backward compatible)
		a.bd, err = buildDeps(cfg)
	}
	if err != nil {
		return nil, err
	}
	dmlog.Infof(nil, "workspace manager ready rev=%d bytes=%d", a.bd.wsMgr.CurrentRev(), len(a.bd.wsMgr.Raw()))

	// UPDATE_NOTICE_SRS FR-UPD-1·8a: 확인 주체는 **서버 프로세스 하나**다.
	// 브라우저가 몇이든 확인 횟수는 늘지 않고, 결과가 바뀌었을 때만 방송한다.
	//
	// 여기서 만드는 것은 방송 상대(`Commands`)가 이미 서 있는 자리가 여기이기
	// 때문이다. buildDeps 안에서 만들면 `conf` 를 한 번 더 읽어야 한다.
	a.updates = updatecheck.New(updatecheck.Options{
		Home:    home,
		Current: cli.Version,
		Enabled: conf.UpdateCheck,
		Broadcast: func() {
			if a.bd.deps.Commands != nil {
				a.bd.deps.Commands.Broadcast(hub.UpdateChangedPayload())
			}
		},
	})
	a.bd.deps.Updates = a.updates

	a.srv, err = httpapi.New(cfg, a.bd.deps)
	if err != nil {
		return nil, errors.Join(errServerInit, err)
	}
	return a, nil
}

// errRuntimeInstall·errServerInit 은 조립 실패의 자리를 가른다 — `serve` 가 로그
// 문구를 고른다.
var (
	errRuntimeInstall = errors.New("runtime install")
	errServerInit     = errors.New("server init")
)

// wireDaemonPushes 는 데몬 모드의 push 콜백이다 — 출력은 해석층 → 주의 추적,
// 종료는 해석층 → 활동 정리 → 백그라운드 방송, 전경은 방송.
func (a *app) wireDaemonPushes() {
	attnTracker := a.bd.attnTracker
	if attnTracker == nil {
		return
	}
	a.panedClient.SetOnOutput(func(toolID string, data []byte, _ int64) {
		attnTracker.FeedOutput(toolID, data)
	})
	// FR-ATL-3: 활동만 내리고 주의를 남기면 죽은 도구의 알람이 배지에
	// 남는다. 두 레이어를 같은 콜백에서 함께 정리한다 — Forget 이
	// 주의 해제(에지)와 상태 폐기를 한 번에 한다.
	a.panedClient.SetOnExit(func(toolID string, info toolhub.ExitInfo) {
		attnTracker.SetActivity(toolID, "ended", "", "")
		attnTracker.Forget(toolID)
		// UX_BATCH6_SRS FR-BGP-1·2: 백그라운드 목록은 살아 있는
		// 프로세스의 목록이다. 데몬 모드에서 그 죽음을 웹서버가 아는
		// 자리는 여기 하나다 — direct 모드의 짝은 `hub.WireBackground`.
		//
		// **백그라운드였는지 가리지 않는다.** 그 사실을 아는 것은 데몬의
		// 레지스트리이고, 여기 닿을 때는 이미 지워진 뒤다. 방송이 나르는
		// 것은 "다시 물어라" 한 줄이므로(BackgroundChangedPayload), 탭에
		// 붙은 도구가 죽었을 때 한 번 더 묻는 값은 목록 조회 한 번이다 —
		// 가리려고 데몬에 왕복을 더하는 것보다 싸다.
		a.bd.deps.Commands.Broadcast(hub.BackgroundChangedPayload())
	})
	// FR-TAN-7: PTY 를 dongminald 가 들고 있으므로 전경 이름은 IPC push
	// 로 온다. direct 모드의 WireForeground 와 같은 Broadcast 에 잇는다.
	a.panedClient.SetOnForeground(hub.BroadcastForeground(a.bd.deps.Commands))
}

// run 은 기동이다 — 스위퍼·폴·감시·리퍼를 ctx 에 묶어 띄우고 HTTP 서버를 돌린다.
// ctx 가 끝나면 서버가 멈추고 돌아온다; 종료는 shutdown 의 일이다.
func (a *app) run(ctx context.Context) error {
	bd := a.bd
	// Close daemon connection IMMEDIATELY on signal, before HTTP server shutdown.
	// This lets dongminald accept the new dongminal's connection right away.
	if a.panedClient != nil {
		go func() {
			<-ctx.Done()
			a.panedClient.Close()
		}()
	}

	// 스위퍼의 틱은 여기서 만든다 — 스위퍼는 틱을 받을 뿐 시계를 갖지 않는다
	// (TEST-8). 티커는 ctx 와 함께 멈춘다.
	if bd.pm != nil {
		tk := time.NewTicker(toolhub.AttentionSweepInterval)
		context.AfterFunc(ctx, tk.Stop)
		bd.pm.StartAttentionSweeper(ctx.Done(), tk.C)
	}
	if bd.attnTracker != nil {
		tk := time.NewTicker(hub.SweeperInterval)
		context.AfterFunc(ctx, tk.Stop)
		bd.attnTracker.StartSweeper(ctx.Done(), tk.C)
	}
	if bd.sampler != nil {
		bd.sampler.Start(ctx.Done())
	}
	// FR-TAN-8: 전경 조회를 돌리는 주체. 두 모드가 이 하나를 쓴다 — List() 가
	// direct 에서는 ForegroundNames() 를 직접 부르고, 데몬에서는 list RPC 가
	// 되어 dongminald 안에서 같은 일을 시킨다.
	hub.StartForegroundPoll(bd.deps.Tools, ctx.Done())
	// GIT_PUSH_OBSERVE_SRS FR-GPO-1·13: 저장소 signature 를 확인해 바뀌었을 때만
	// 알린다. 브라우저가 500ms 마다 묻던 것을 서버가 대신 본다 — 그 확인은 git 을
	// 실행하지 않고 read 1회 + stat 2회다.
	a.srv.StartGitWatch(ctx.Done())
	// UX_REVISION_SRS FR-DEL-14/18: 끝난 Run 과 조정자를 잃은 Run 을 거둔다.
	// 부팅 직후 한 번 돌므로 epoch 펜싱이 aborted 로 표시한 Run 도 여기서 사라진다.
	a.srv.StartRunReaper(ctx.Done())
	// ACCESS_ALLOWLIST_SRS FR-ACL-5a·15: 허용 목록의 호스트명 해석과 이 머신의
	// 인터페이스 주소를 주기적으로 갱신한다. 요청 경로는 그 결과만 읽는다 —
	// 게이트 판정에 DNS 왕복이 붙으면 모든 요청이 그만큼 느려진다.
	a.srv.StartAccessRefresh(ctx.Done())
	// UPDATE_NOTICE_SRS FR-UPD-2 ①·③: 기동 확인 한 번과 24시간 마감.
	// 마감은 **한 번도 끄지 않고 띄워 둔 세션**만을 위한 보조다 — 갱신의 주된
	// 계기는 SSE 연결 수립이고 그쪽은 요청 경로에 있다.
	if a.updates != nil {
		a.updates.Start()
	}
	// RECONNECT_STORM_SRS FR-LOG-1: 서버가 자기 로그의 크기를 스스로 지킨다.
	// 폭주가 4.17 GB 를 만든 뒤에도 상한이 없다는 사실은 그대로였다.
	go cli.WatchLogSize(ctx.Done())
	// TLS-2: 판정은 `dmenv` 한 벌이다. 종전에는 여기서도 `0.0.0.0`/`::` 만
	// 보아 `DONGMINAL_HOST=192.168.1.5` 기동이 `local-only` 로 남았다.
	exposure := dmenv.ExposureLabel(a.host)
	if exposure == "exposed" {
		exposure = "exposed to LAN"
	}
	// 플랫폼을 남긴다. 크로스플랫폼 문제 보고에서 가장 먼저 필요한 값이고,
	// WSL 은 리눅스와 빌드가 같아 로그 없이는 구별되지 않는다 (FR-XWS-1).
	dmlog.Infof(nil, "dongminal starting on http://%s:%s (%s, platform=%s)",
		a.host, a.port, exposure, platform.Current().OS)

	// OBSERVABILITY_SRS FR-OBS-15·16 (M5 `G2-6`): 마지막 종료가 정상이었는가.
	//
	// 워크스페이스 손상과 강제 종료는 **증상이 같고 조치가 다르다** — "창이
	// 사라졌다" 는 신고에서 이 한 줄이 둘을 가른다. 판정을 먼저 하고 그 뒤에
	// 덮는다: 읽기가 판정만 하므로 순서가 곧 계약이다.
	if le := platform.ReadLastExit(a.home); le.Crashed {
		dmlog.Warn(nil, "지난 종료가 정상 경로를 지나지 않았습니다 (강제 종료·크래시·전원 차단)",
			"marker", platform.LastExitFile)
	} else if le.First {
		dmlog.Debug(nil, "종료 마커가 없습니다 — 첫 기동이거나 지워졌습니다")
	}
	platform.MarkRunning(a.home)

	// FR-LSP-17: 쓰이지 않는 언어 서버를 주기적으로 정지시킨다. 서버 수명과 함께
	// 시작하고 끝난다 — 진단 스냅샷(runDiagSnapshots)과 같은 규약이다.
	if bd.lspSvc != nil {
		go bd.lspSvc.RunSweeper(ctx)
	}

	// 조립은 `dmenv.ListenAddr` 이 한다 (FR-STR-20·21). 문자열 접합으로 만들면
	// `DONGMINAL_HOST=::1` 이 `net.Listen` 에서 *too many colons* 로 죽고, 부모는
	// 5초 폴링 뒤 "기동 실패" 만 낸다 — 어느 값이 문제인지가 없다.
	return a.srv.Run(ctx, dmenv.ListenAddr(a.host, a.port))
}

// shutdownStep 은 종료 순서의 한 칸이다. 조립되지 않은 구성원은 fn 안에서 건너뛴다.
type shutdownStep struct {
	name string
	fn   func()
}

// shutdownSteps 는 종료 순서다 — **이 순서가 계약이다** (D-A-12).
//
//  1. 마커 — 여기를 지났으면 정상 종료다. 다음 기동이 이 한 글자로 "강제로
//     죽었는가" 에 답한다 (OBSERVABILITY_SRS FR-OBS-15).
//  2. 데몬 연결 — 먼저 놓아야 dongminald 가 새 서버의 연결을 받는다.
//  3. 도구 저장 — 문을 닫고 인플라이트 저장을 거둔 뒤 마지막 상태를 쓴다 (boot.go 와 같다).
//  4. 샌드박스 — 컨테이너는 **정지**한다. 지우지 않는 것은 창이 workspace 에 그대로
//     남아 있기 때문이다 — 다음 기동에서 그 창을 열면 하던 자리로 돌아간다 (FR-SBX-44).
//  5. LSP — 언어 서버는 **정지**한다 (FR-LSP-18). 남겨 둘 상태가 없고, 정지하지 않으면
//     큰 저장소에서 수백 MB 를 쓰는 프로세스가 서버보다 오래 산다.
//  6. 워크스페이스 — 비동기 writer 를 flush 한다.
func (a *app) shutdownSteps() []shutdownStep {
	return []shutdownStep{
		{"마커", func() {
			if a.home != "" {
				platform.MarkCleanExit(a.home)
			}
		}},
		{"데몬 연결", func() {
			if a.panedClient != nil {
				a.panedClient.Close()
			}
		}},
		{"도구 저장", func() {
			if a.bd.pm != nil {
				a.bd.pm.StopSaving()
				a.bd.pm.SaveAll()
			}
		}},
		{"샌드박스", func() {
			if a.bd.deps.Sandbox != nil {
				a.bd.deps.Sandbox.Shutdown()
			}
		}},
		{"LSP", func() {
			if a.bd.lspSvc != nil {
				a.bd.lspSvc.Shutdown()
			}
		}},
		{"판 확인", func() {
			if a.updates != nil {
				a.updates.Stop()
			}
		}},
		{"워크스페이스", func() {
			if a.bd.wsMgr != nil {
				_ = a.bd.wsMgr.Close()
			}
		}},
	}
}

// shutdown 은 표를 순서대로 돈다.
func (a *app) shutdown() {
	for _, st := range a.shutdownSteps() {
		st.fn()
	}
}

// serve는 웹 서버를 이 프로세스로 실행한다 (FR-FG-1). `dongminal start
// --foreground` 의 실체이며, 배경 모드는 자기 자신을 이 형태로 재실행한다.
func serve(home, host, port string) int {
	a, err := buildApp(home, host, port)
	if err != nil {
		switch {
		case errors.Is(err, workspace.ErrSchemaTooOld):
			// 스키마 미달은 사용자가 조치할 수 있는 상태다 — 스택 대신 안내를 낸다.
			dmlog.Infof(nil, "workspace.json 이 구 스키마입니다.")
			dmlog.Infof(nil, "  1) 서버와 데몬을 완전히 정지: dongminal stop --all")
			dmlog.Infof(nil, "  2) 변환 내용 확인:            dongminal migrate --dry-run")
			dmlog.Infof(nil, "  3) 변환 실행:                 dongminal migrate")
		case errors.Is(err, errRuntimeInstall), errors.Is(err, errServerInit):
			dmlog.Infof(nil, "%v", err)
		default:
			dmlog.Infof(nil, "buildDeps: %v", err)
		}
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), platform.Current().Process.ShutdownSignals()...)
	defer stop()

	runErr := a.run(ctx)

	dmlog.Infof(nil, "shutting down")
	a.shutdown()
	if runErr != nil {
		dmlog.Infof(nil, "server fatal: %v", runErr)
		return 1
	}
	dmlog.Infof(nil, "server stopped")
	return 0
}
