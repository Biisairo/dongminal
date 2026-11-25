//! 서버 프로세스 하나의 조립·기동·종료다 (Go `app.go`, M8 D-A-12). 종료 순서는 [`App::shutdown_steps`]
//! 의 표이고 시험이 그 이름 순서를 잰다.

mod adapters;
mod attention;
mod compose;
mod lsp_watch;
mod records;
mod signals;

use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use otter_ctl_cli::{ServeTarget, VERSION};
use otter_gocompat::filepath;
use otter_shared_activity as activity;
use otter_shared_otterenv as otterenv;
use otter_shared_otterlog::{self as otterlog, Value, debug, errorf, infof, warn, warnf};
use otter_shared_platform as platform;
use otter_shared_serverconf as serverconf;
use otter_shared_toolhub::ExitInfo;
use otter_shared_toolipc::{ChatEvent, EdgesEvent, ReportEvent};
use otter_shared_updatecheck::{self as updatecheck, Checker};
use otter_webserver_domain_git_core::{self as git_core, Ctx};
use otter_webserver_httpapi::{Config, Server, WebAssets};
use otter_webserver_hub as hub;
use otter_webserver_recordsync::Writer;
use otter_webserver_toolclient::ToolClient;
use tokio_util::sync::CancellationToken;

use crate::daemon::{DaemonUnavailable, dial_or_start_daemon};
use adapters::{Daemon, Records, Updates};
use attention::{sync_attn_config, wire_daemon_attention};
use compose::{BuiltDeps, build_deps_with_hub};
use records::{new_record_writer, new_report_queue, sync_records};

/// 종료가 git 잡·쓰기를 기다리는 상한이다 (REPO_FIX 01 §8) — 취소된 git 은 신호 시퀀스(2·KillGrace)
/// 안에 끝나고 1s 를 더 준다.
pub(crate) const GIT_DRAIN_WAIT: Duration =
    Duration::from_secs(2 * git_core::KILL_GRACE.as_secs() + 1);

/// 조립 실패의 자리다 — `serve` 가 로그 문구를 고른다 (Go `errRuntimeInstall`·`errDaemonUnavailable`
/// 과 workspace 오류). Go 의 `errServerInit` 은 `httpapi::Server::new` 가 실패하지 않아 없다.
#[derive(Debug)]
pub(crate) enum BuildError {
    /// workspace.json 이 구 스키마다. 안의 값은 원인 문구다.
    SchemaTooOld(String),
    /// Go `errors.Join(errRuntimeInstall, err)` 다. 안의 값은 원인 문구다.
    RuntimeInstall(String),
    Daemon(DaemonUnavailable),
    Other(String),
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SchemaTooOld(e) | Self::Other(e) => f.write_str(e),
            Self::RuntimeInstall(e) => write!(f, "runtime install\n{e}"),
            Self::Daemon(e) => e.fmt(f),
        }
    }
}

/// 종료 순서의 한 칸이다. 조립되지 않은 구성원은 몸 안에서 건너뛴다.
pub(crate) struct ShutdownStep<'a> {
    #[cfg_attr(not(test), expect(dead_code, reason = "이름 순서는 시험이 잰다"))]
    pub(crate) name: &'static str,
    pub(crate) run: Box<dyn FnOnce() + 'a>,
}

type CancelFn = Arc<dyn Fn() + Send + Sync>;

/// 서버 프로세스 하나다 (Go `app`).
#[derive(Default)]
pub(crate) struct App {
    home: String,
    host: String,
    port: String,
    client: Option<Arc<ToolClient>>,
    bd: BuiltDeps,
    srv: Option<Arc<Server>>,
    /// 최신 판 캐시다 (UPDATE_NOTICE_SRS). 조립에서 만들고 run 이 시작하며 종료 표가 멈춘다.
    updates: Option<Checker>,
    /// git 의 서버 수명 문맥을 끝낸다 (REPO_FIX 01 §8).
    cancel_git: Option<CancelFn>,
    /// 에이전트 기록을 데몬에 쓰는 큐다 (FR-ARD-11).
    records: Option<Arc<Writer>>,
    /// 서버보다 먼저 거는 push 콜백이 서버를 찾는 자리다. 서버가 서면 채운다.
    late_srv: Arc<OnceLock<Weak<Server>>>,
}

/// `start --foreground` 의 실체다 (FR-FG-1). 배경 모드는 자기 자신을 이 형태로 재실행한다.
pub(crate) fn serve(t: &ServeTarget<'_>) -> i32 {
    // Go buildApp 의 `os.Setenv(OTTERMINAL_HOME, home)`: 서버가 띄우는 자식(git hook·언어 서버·확장
    // 설치)이 이 홈을 물려받는다. 런타임·스레드를 세우기 전인 여기서만 쓸 수 있다.
    if let Err(e) = platform::set_env_before_threads(otterenv::ENV_HOME, t.home) {
        errorf!(None, "{}: {e}", otterenv::ENV_HOME);
    }
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            errorf!(None, "runtime: {e}");
            return 1;
        }
    };
    let code = {
        let _enter = rt.enter();
        serve_in(&rt, t)
    };
    // 떠 있는 작업(감시·스위퍼)을 기다리지 않는다 — Go 는 serve 가 돌아오면 프로세스가 끝난다.
    rt.shutdown_background();
    code
}

fn serve_in(rt: &tokio::runtime::Runtime, t: &ServeTarget<'_>) -> i32 {
    // REPO_FIX 01 §8: git 의 서버 수명. 조립 전에 만들어 Store·잡이 파생하게 한다.
    let git_root = Ctx::background().with_cancel();
    let home = t.home.to_owned();
    let tool_home = t.tool_home.to_owned();
    let built = build_app(git_root.clone(), t.home, t.host, t.port, move || {
        dial_or_start_daemon(&home, &tool_home)
    });
    let mut app = match built {
        Ok(a) => a,
        Err(e) => {
            report_build_error(t.home, &e);
            git_root.cancel();
            return 1;
        }
    };
    let cancel = git_root.clone();
    app.cancel_git = Some(Arc::new(move || cancel.cancel()));

    let ctx = CancellationToken::new();
    {
        let (ctx, git_root) = (ctx.clone(), git_root.clone());
        let signals = signals::shutdown_signals(platform::current().process.shutdown_signals());
        rt.spawn(async move {
            signals.await;
            ctx.cancel();
            // 신호가 오면 HTTP 종료를 기다리지 않고 곧바로 git 을 끊는다 — 진행 중인 쓰기는 503
            // server_shutdown, 잡은 server_shutdown 으로 끝난다.
            git_root.cancel();
        });
    }

    let run_err = rt.block_on(app.run(ctx));

    infof!(None, "shutting down");
    app.shutdown();
    git_root.cancel();
    if let Err(e) = run_err {
        infof!(None, "server fatal: {e}");
        return 1;
    }
    infof!(None, "server stopped");
    0
}

fn report_build_error(home: &str, e: &BuildError) {
    match e {
        // 스키마 미달은 사용자가 조치할 수 있는 상태다 — 스택 대신 안내를 낸다.
        BuildError::SchemaTooOld(_) => {
            infof!(None, "workspace.json 이 구 스키마입니다.");
            infof!(
                None,
                "  1) 서버와 데몬을 완전히 정지: otterminal stop --all"
            );
            infof!(
                None,
                "  2) 변환 내용 확인:            otterminal migrate --dry-run"
            );
            infof!(None, "  3) 변환 실행:                 otterminal migrate");
        }
        BuildError::RuntimeInstall(_) => infof!(None, "{e}"),
        // FR-DMR-2: 원인과 데몬 로그의 자리를 함께 낸다 — 데몬의 실패 사유는 그쪽에 있다.
        BuildError::Daemon(_) => {
            errorf!(None, "{e}");
            errorf!(
                None,
                "  데몬 로그: {}",
                filepath::join(&[home, otterenv::DAEMON_LOG_FILE])
            );
        }
        BuildError::Other(_) => infof!(None, "buildApp: {e}"),
    }
}

/// 조립이다 — 로그 계층·헬퍼 설치·데몬 연결·의존 배선·서버·해석층 되살림. 여기서 돌아오면 요청을
/// 받을 수 있는 상태이며 아직 아무것도 돌지 않는다. tokio 런타임 문맥 안에서 부른다.
pub(crate) fn build_app(
    git_ctx: Ctx,
    home: &str,
    host: &str,
    port: &str,
    dial: impl FnOnce() -> Result<ToolClient, DaemonUnavailable>,
) -> Result<App, BuildError> {
    // 바인드는 환경변수로 넘기지 않는다 — 헬퍼는 주소 파일로 서버를 찾는다 (FR-HRB-11·12). 홈은
    // serve 가 스레드를 세우기 전에 환경에 넣었다.

    // CONFIG_MANAGEMENT_SRS FR-CFG-13: 홈이 정해졌으므로 파일 계층까지 읽어 로그 수준을 다시 세운다.
    let conf = serverconf::resolve(&serverconf::Inputs {
        home: Path::new(home),
        ..Default::default()
    });
    for w in &conf.warnings {
        warnf!(None, "{w}");
    }
    otterlog::init(otterlog::Options {
        level: conf.log_level.value.clone(),
        out: None,
    });

    if let Err(e) =
        otter_shared_runtime::install(Path::new(&filepath::join(&[home, otterenv::BIN_DIR])))
    {
        return Err(BuildError::RuntimeInstall(e.to_string()));
    }

    // FR-VHL-10: 서버의 빌드 판을 헬스가 쓴다. 데몬과 같은 출처(cli VERSION)를 본다.
    let cfg = Config {
        port: port.to_owned(),
        data_dir: PathBuf::from(home),
        static_fs: Some(Arc::new(WebAssets)),
        version: VERSION.to_owned(),
        ..Config::default()
    };

    // DIRECT_MODE_REMOVAL_SRS FR-DMR-1·2: 서버는 늘 데몬에 붙는다. 붙지 못하면 리스너를 열지 않는다.
    let client = Arc::new(dial().map_err(BuildError::Daemon)?);
    let mut a = App {
        home: home.to_owned(),
        host: host.to_owned(),
        port: port.to_owned(),
        client: Some(client.clone()),
        ..App::default()
    };
    a.bd = match build_deps_with_hub(&cfg, client.clone(), git_ctx) {
        Ok(bd) => bd,
        Err(e) => {
            client.close();
            if e.is_schema_too_old() {
                return Err(BuildError::SchemaTooOld(e.to_string()));
            }
            return Err(BuildError::Other(e.to_string()));
        }
    };
    a.wire_daemon_pushes();
    // PEER_DAEMON_SRS §3.5a: 데몬이 노드다. PEER_CHAT_SRS §3.11: 채팅의 사람 참가자도 데몬에 있다.
    a.bd.deps.edge_daemon = Some(Arc::new(Daemon(client.clone())));
    a.bd.deps.chat_daemon = Some(Arc::new(Daemon(client.clone())));
    a.bd.deps.screen_daemon = Some(Arc::new(Daemon(client.clone())));
    if let Some(tr) = a.bd.attn_tracker.clone() {
        let w = new_record_writer(client.clone(), &tr);
        a.bd.deps.records = Some(Arc::new(Records(w.clone())));
        a.records = Some(w);
        a.bd.deps.attn_daemon = Some(Arc::new(wire_daemon_attention(&client, &tr)));
    }
    if let Some(ws) = &a.bd.ws_mgr {
        infof!(
            None,
            "workspace manager ready rev={} bytes={}",
            ws.current_rev(),
            ws.raw().len()
        );
    }

    // UPDATE_NOTICE_SRS FR-UPD-1·8a: 확인 주체는 서버 프로세스 하나다. 결과가 바뀌었을 때만 방송한다.
    // 서버는 확인기보다 뒤에 서므로, 결과는 선 뒤의 서버가 `update` 토픽으로 낸다 (CHANNEL_PROTOCOL C2b).
    let srv_cell: Arc<std::sync::OnceLock<std::sync::Weak<Server>>> = Arc::default();
    let cell = srv_cell.clone();
    let updates = Checker::new(updatecheck::Options {
        home: PathBuf::from(home),
        current: VERSION.to_owned(),
        enabled: conf.update_check,
        // DIFF(8.2-fix): Go 는 Getenv 를 넘기지 않아 `OTTERMINAL_NO_UPDATE_CHECK` 가 먹지 않았다.
        getenv: Some(Arc::new(|k: &str| std::env::var(k).unwrap_or_default())),
        broadcast: Some(Arc::new(move || {
            if let Some(s) = cell.get().and_then(std::sync::Weak::upgrade) {
                s.update_changed();
            }
        })),
        ..Default::default()
    });
    a.bd.deps.updates = Some(Arc::new(Updates(updates.clone())));
    a.updates = Some(updates);

    let srv = Server::new(cfg, a.bd.deps.clone());
    let _ = srv_cell.set(Arc::downgrade(&srv));
    let _ = a.late_srv.set(Arc::downgrade(&srv));
    // Go `New` 는 주입된 Commands 가 *CommandHub 이면 스스로 Telegram 관찰자를 단다. Rust 는 허브를
    // 내려 볼 수 없어 합성 루트가 단다.
    if let Some(h) = &a.bd.cmd_hub {
        srv.wire_telegram_attention(h);
    }
    a.srv = Some(srv);
    a.wire_daemon_records();
    a.wire_daemon_edges();
    Ok(a)
}

impl App {
    /// 데몬 노드의 push 와 재접속을 서버에 잇는다 (PEER_DAEMON_SRS FR-PDM-27·33). 서버가 선 뒤에
    /// 건다 — 콜백이 서버를 부른다.
    fn wire_daemon_edges(&self) {
        let (Some(c), Some(srv)) = (&self.client, &self.srv) else {
            return;
        };
        let w = Arc::downgrade(srv);
        c.set_on_edges(Some(Arc::new(with_srv(&w, |s, ev: EdgesEvent| {
            s.edge_pushed(&ev)
        }))));
        let r = w.clone();
        c.set_on_edge_resync(Some(Arc::new(move || {
            if let Some(s) = r.upgrade() {
                s.edge_resync()
            }
        })));
        // PEER_CHAT_SRS §3.11: 사람에게 온 글과 채팅 바뀜을 화면에 방송한다.
        c.set_on_chat(Some(Arc::new(with_srv(&w, |s, ev: ChatEvent| {
            s.chat_pushed(&ev)
        }))));
        c.set_on_chat_resync(Some(Arc::new(move || {
            if let Some(s) = w.upgrade() {
                s.chat_resync()
            }
        })));
    }

    /// 데몬 모드의 push 콜백이다 — 출력은 주의 추적, 종료는 활동 정리 → 백그라운드 방송, 전경은 방송.
    fn wire_daemon_pushes(&self) {
        let (Some(c), Some(tr)) = (&self.client, &self.bd.attn_tracker) else {
            return;
        };
        let out = Arc::clone(tr);
        c.set_on_output(Some(Arc::new(move |id: &str, data: &[u8], _seq: i64| {
            out.feed_output(id, data)
        })));
        // FR-ATL-3: 활동만 내리고 주의를 남기면 죽은 도구의 알람이 배지에 남는다. 두 레이어를 같은
        // 콜백에서 정리한다. UX_BATCH6_SRS FR-BGP-1·2: 백그라운드였는지 가리지 않고 "다시 물어라" 를
        // 방송한다 — 그 사실을 아는 데몬의 레지스트리는 여기 닿을 때 이미 지워졌다.
        // PERF M4 S7: 조정자 도구가 끝났을 수 있으니 Run 수거를 깨운다. 재접속 뒤 놓친 종료도 이
        // 콜백으로 온다.
        let exit = Arc::clone(tr);
        let commands = self.bd.deps.commands.clone();
        let late = Arc::clone(&self.late_srv);
        c.set_on_exit(Some(Arc::new(move |id: &str, _info: ExitInfo| {
            exit.set_activity(id, activity::ENDED, "", "");
            exit.forget(id);
            if let Some(c) = &commands {
                c.broadcast(&hub::background_changed_payload());
            }
            if let Some(s) = late.get().and_then(Weak::upgrade) {
                s.kick_run_reap();
            }
        })));
        // FR-TAN-7: PTY 를 데몬이 들고 있으므로 전경 이름은 IPC push 로 온다.
        if let Some(cmds) = self.bd.deps.commands.clone() {
            c.set_on_foreground(Some(Arc::new(hub::broadcast_foreground(cmds))));
        }
    }

    /// 데몬의 기록을 거울에 잇는다 (FR-ARD-13). HTTP 를 열기 전에 스냅샷을 반영하므로, 처음 받는
    /// 보고가 낡은 스냅샷에 덮이지 않는다.
    fn wire_daemon_records(&self) {
        let (Some(c), Some(srv)) = (&self.client, &self.srv) else {
            return;
        };
        srv.sync_screen_config();
        // §3.2a: 서버는 hello 에서 reports 를 말하므로 report push 는 언제나 받아야 한다.
        let w = Arc::downgrade(srv);
        let queue = new_report_queue(move |method: &str, body: &[u8]| {
            if let Some(s) = w.upgrade() {
                s.apply_report(method, body)
            }
        });
        c.set_on_report(Some(Arc::new(move |ev: ReportEvent| queue(ev))));
        let Some(writer) = &self.records else {
            return;
        };
        sync_records(&**c, writer, &**srv);
        let (wc, ws, ww) = (
            Arc::downgrade(c),
            Arc::downgrade(srv),
            Arc::downgrade(writer),
        );
        c.set_on_resync(Some(Arc::new(move || {
            let (Some(c), Some(s), Some(w)) = (wc.upgrade(), ws.upgrade(), ww.upgrade()) else {
                return;
            };
            sync_attn_config(&*c);
            s.sync_screen_config();
            sync_records(&*c, &w, &*s);
            s.kick_run_reap();
        })));
    }

    /// 기동이다 — 감시·리퍼를 ctx 에 묶어 띄우고 HTTP 서버를 돌린다. ctx 가 끝나면 서버가
    /// 멈추고 돌아온다. 종료는 [`App::shutdown`] 의 일이다.
    pub(crate) async fn run(&self, ctx: CancellationToken) -> std::io::Result<()> {
        let Some(srv) = self.srv.clone() else {
            return Ok(());
        };
        // 신호가 오면 HTTP 종료보다 먼저 데몬 연결을 닫는다 — 데몬이 새 서버의 연결을 곧바로 받는다.
        if let Some(c) = self.client.clone() {
            let ctx = ctx.clone();
            tokio::spawn(async move {
                ctx.cancelled().await;
                let _ = tokio::task::spawn_blocking(move || c.close()).await;
            });
        }

        if let Some(w) = &self.records {
            w.start(ctx.clone());
        }
        // GIT_PUSH_OBSERVE_SRS FR-GPO-1·13: 저장소 signature 가 바뀌었을 때만 알린다.
        srv.start_git_watch(ctx.clone());
        // UX_REVISION_SRS FR-DEL-14/18: 끝난 Run 과 조정자를 잃은 Run 을 거둔다. 기동 때 한 번, 그 뒤
        // 도구 종료·Run 닫기·데몬 재접속 때만 돈다 (PERF M4 S7).
        srv.start_run_reaper(ctx.clone());
        // ACCESS_ALLOWLIST_SRS FR-ACL-5a·15: 허용 목록의 해석과 인터페이스 주소를 주기적으로 갱신한다.
        srv.start_access_refresh(ctx.clone());
        // PEER_NETWORK_SRS FR-PNW-4: 노드 포트. 꺼져 있으면 아무것도 열지 않는다.
        let edge_srv = srv.clone();
        let close_edge = start_edge_scoped(ctx.clone(), move |stop| edge_srv.start_edge(stop));
        // TELEGRAM_BRIDGE_SRS NFR-TGB-1·CLAUDE_ACCOUNTS_SRS FR-CAC-50: 꺼져 있으면 아무 요청도 없다.
        drop(srv.start_telegram(ctx.clone()));
        srv.start_claude_accounts(ctx.clone());
        // UPDATE_NOTICE_SRS FR-UPD-2 ①·③: 기동 확인 한 번과 24시간 마감.
        if let Some(u) = &self.updates {
            u.start();
        }
        // RECONNECT_STORM_SRS FR-LOG-1: 서버가 자기 로그의 크기를 스스로 지킨다.
        {
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let home = self.home.clone();
            std::thread::spawn(move || otter_ctl_cli::watch_log_size_in(&home, &rx));
            let ctx = ctx.clone();
            tokio::spawn(async move {
                ctx.cancelled().await;
                drop(tx);
            });
        }
        // TLS-2: 판정은 otterenv 한 벌이다.
        let exposure = match otterenv::exposure_label(&self.host) {
            "exposed" => "exposed to LAN",
            other => other,
        };
        // 플랫폼을 남긴다 — WSL 은 리눅스와 빌드가 같아 로그 없이는 구별되지 않는다 (FR-XWS-1).
        infof!(
            None,
            "otterminal starting on http://{}:{} ({exposure}, platform={})",
            self.host,
            self.port,
            platform::current().os
        );

        // OBSERVABILITY_SRS FR-OBS-15·16: 마지막 종료가 정상이었는가. 판정을 먼저 하고 그 뒤에 덮는다.
        let home = Path::new(&self.home);
        let le = platform::read_last_exit(home);
        if le.crashed {
            warn(
                None,
                "지난 종료가 정상 경로를 지나지 않았습니다 (강제 종료·크래시·전원 차단)",
                &[("marker", Value::Str(platform::LAST_EXIT_FILE.to_owned()))],
            );
        } else if le.first {
            debug(
                None,
                "종료 마커가 없습니다 — 첫 기동이거나 지워졌습니다",
                &[],
            );
        }
        platform::mark_running(home);

        // FR-LSP-17: 쓰이지 않는 언어 서버를 주기적으로 정지시킨다. 서버 수명과 함께 시작하고 끝난다.
        if let Some(lsp) = self.bd.lsp_svc.clone() {
            tokio::spawn(lsp.run_sweeper(ctx.clone()));
        }

        // 주소 조립은 otterenv 가 한다 (FR-STR-20·21) — `::1` 같은 호스트도 한 함수가 감싼다.
        let res = srv
            .run(ctx, &otterenv::listen_addr(&self.host, &self.port))
            .await;
        // 노드 포트를 닫고 기다린다. Run 이 종료 신호 없이 실패해도(포트 사용 중) 닫는다 (C7).
        close_edge.await;
        res
    }

    /// 종료 순서다 — **이 순서가 계약이다** (D-A-12).
    ///
    ///  0. git 잡·쓰기 대기 — 마커 앞이다. 마커 뒤에 git 이 index.lock 을 남긴 채 끊기면 마커가 거짓이 된다.
    ///  1. 마커 — 여기를 지났으면 정상 종료다 (FR-OBS-15).
    ///  2. 데몬 연결 — 먼저 놓아야 데몬이 새 서버의 연결을 받는다.
    ///  3. 샌드박스 — 컨테이너는 정지한다. 창이 workspace 에 남아 다음 기동에서 이어진다 (FR-SBX-44).
    ///  4. LSP — 언어 서버는 정지한다 (FR-LSP-18).
    ///  5. 판 확인 — 최신 판 캐시의 시계를 멈춘다.
    ///  6. 워크스페이스 — 비동기 writer 를 flush 한다.
    pub(crate) fn shutdown_steps(&self) -> Vec<ShutdownStep<'_>> {
        vec![
            ShutdownStep {
                name: "git 잡·쓰기 대기",
                run: Box::new(|| {
                    if let Some(cancel) = &self.cancel_git {
                        cancel();
                    }
                    if !drain_git() {
                        warnf!(
                            None,
                            "git 실행이 {} 안에 끝나지 않았습니다 — 기다리지 않고 종료합니다",
                            otter_gocompat::time::format_std_duration(GIT_DRAIN_WAIT)
                        );
                    }
                }),
            },
            ShutdownStep {
                name: "마커",
                run: Box::new(|| {
                    if !self.home.is_empty() {
                        platform::mark_clean_exit(Path::new(&self.home));
                    }
                }),
            },
            ShutdownStep {
                name: "데몬 연결",
                run: Box::new(|| {
                    if let Some(c) = &self.client {
                        c.close();
                    }
                }),
            },
            ShutdownStep {
                name: "샌드박스",
                run: Box::new(|| {
                    if let Some(s) = &self.bd.sandbox {
                        s.shutdown();
                    }
                }),
            },
            ShutdownStep {
                name: "LSP",
                run: Box::new(|| {
                    if let Some(l) = &self.bd.lsp_svc {
                        l.shutdown();
                    }
                }),
            },
            ShutdownStep {
                name: "판 확인",
                run: Box::new(|| {
                    if let Some(u) = &self.updates {
                        u.stop();
                    }
                }),
            },
            ShutdownStep {
                name: "워크스페이스",
                run: Box::new(|| {
                    if let Some(ws) = &self.bd.ws_mgr {
                        ws.close();
                    }
                }),
            },
        ]
    }

    /// 표를 순서대로 돈다.
    pub(crate) fn shutdown(&self) {
        for st in self.shutdown_steps() {
            (st.run)();
        }
    }
}

/// 떠 있는 git 이 끝나기를 [`GIT_DRAIN_WAIT`] 까지 기다린다. 종료 표는 런타임 밖(또는 진입만 한
/// 문맥)에서 돈다. 기다릴 런타임을 세우지 못하면 기다리지 않는다.
fn drain_git() -> bool {
    let wait = git_core::drain(GIT_DRAIN_WAIT);
    match tokio::runtime::Handle::try_current() {
        Ok(h) => h.block_on(wait),
        Err(_) => tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map(|rt| rt.block_on(wait))
            .unwrap_or(true),
    }
}

/// 노드 포트를 ctx 가 끝나거나 돌려준 future 를 기다리면 닫히게 띄운다. 돌려준 future 는 닫기가
/// 끝날 때까지 기다린다.
pub(crate) fn start_edge_scoped(
    ctx: CancellationToken,
    start: impl FnOnce(CancellationToken) -> tokio::task::JoinHandle<()>,
) -> impl Future<Output = ()> {
    let scoped = ctx.child_token();
    let done = start(scoped.clone());
    async move {
        scoped.cancel();
        let _ = done.await;
    }
}

/// 서버를 약하게 쥔 push 콜백이다 — 클라이언트가 서버보다 오래 살아도 순환을 만들지 않는다.
fn with_srv<T>(
    w: &Weak<Server>,
    f: impl Fn(&Server, T) + Send + Sync + 'static,
) -> impl Fn(T) + Send + Sync + 'static {
    let w = w.clone();
    move |v: T| {
        if let Some(s) = w.upgrade() {
            f(&s, v)
        }
    }
}

#[cfg(test)]
mod tests;
