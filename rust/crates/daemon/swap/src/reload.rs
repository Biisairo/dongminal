use std::fs::File;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use otter_daemon_ipc::PanedServer;
use otter_gocompat::oserr::go_error_string;
use otter_shared_handover::{self as handover, ReloadRequest};
use otter_shared_otterlog::{errorf, infof};
use otter_shared_toolhub::ToolManager;
use tokio::runtime::Handle;

use crate::state::{State, write_state};
use crate::validate::{Env, Gate, preflight, refuse, validate};

/// 사전 확인의 시한이다 (FR-DSK-12).
pub const PREFLIGHT_WITHIN: Duration = Duration::from_secs(5);

/// 프로세스를 exe 로 갈아 끼운다(exe, argv, env). 성공하면 돌아오지 않고, 실패하면 그 오류다.
pub type ExecFn = Arc<dyn Fn(&str, &[String], &[String]) -> io::Error + Send + Sync>;
/// 새 바이너리의 사전 확인이다. 거절이면 "<사유>: <설명>" 문구다.
pub type PreflightFn = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// 교체기가 기대는 것이다. exec·preflight 는 시험이 갈아 끼운다.
pub struct Deps {
    pub home: PathBuf,
    pub tools: Arc<ToolManager>,
    pub server: PanedServer,
    pub env: Env,
    /// None 이면 실제 사전 확인([`PREFLIGHT_WITHIN`])이다.
    pub preflight: Option<PreflightFn>,
    pub exec: ExecFn,
}

/// 보고 소켓의 교체 요청을 처리한다 (FR-DSK-11~13).
pub struct Reloader {
    d: Deps,
    preflight: PreflightFn,
    gate: Gate,
    rt: Handle,
}

impl Reloader {
    /// 교체기를 만든다. tokio 런타임 안에서 부른다(도구 멈춤이 async 다).
    pub fn new(d: Deps) -> Arc<Self> {
        let preflight = d
            .preflight
            .clone()
            .unwrap_or_else(|| Arc::new(|exe: &str| preflight(exe, PREFLIGHT_WITHIN)));
        Arc::new(Self {
            d,
            preflight,
            gate: Gate::default(),
            rt: Handle::current(),
        })
    }

    /// 검사·사전 확인·멈춤·담기·쓰기를 마치고 commit 을 돌려준다 (FR-DSK-13 1~5). 실패하면
    /// 아무것도 바뀌지 않는다. 런타임 작업 스레드가 아닌 스레드에서 부른다.
    pub fn reload(
        self: &Arc<Self>,
        req: &ReloadRequest,
    ) -> Result<Box<dyn FnOnce() + Send>, String> {
        if !self.gate.enter() {
            return Err(refuse(handover::REASON_BUSY, "다른 교체가 진행 중입니다"));
        }
        let r = validate(req, &self.d.env)
            .and_then(|()| (self.preflight)(&self.d.env.self_exe))
            // 검사를 통과한 요청 경로가 아니라 고정된 자기 경로를 실행한다.
            .and_then(|()| self.prepare(self.d.env.self_exe.clone()));
        match r {
            Ok(p) => Ok(Box::new(move || p.commit())),
            Err(e) => {
                self.gate.leave();
                Err(e)
            }
        }
    }

    /// 보고 소켓([`PanedServer::set_reloader`])에 거는 모양이다.
    pub fn into_ipc(self: Arc<Self>) -> otter_daemon_ipc::Reloader {
        Arc::new(move |req| self.reload(&req))
    }

    fn prepare(self: &Arc<Self>, exe: String) -> Result<Prepared, String> {
        let tools = Arc::clone(&self.d.tools);
        if !self.rt.block_on(async move { tools.freeze_all().await }) {
            return Err(refuse(handover::REASON_STATE, "도구를 멈추지 못했습니다"));
        }
        let fail = |msg: String| {
            self.d.tools.thaw_all();
            refuse(handover::REASON_STATE, msg)
        };
        // 인계 상태를 잃어도 셸을 pid 로 알아보도록 tools.json 을 지금 쓴다 (FR-DSK-27).
        self.d.tools.save_all();
        let tools = self
            .d
            .tools
            .export_handover()
            .map_err(|e| fail(go_error_string(&e)))?;
        let (paned, report) =
            listener_files(&self.d.server).map_err(|e| fail(go_error_string(&e)))?;
        let st = State {
            version: handover::VERSION,
            tools: (!tools.is_empty()).then(|| tools.clone()),
            global: self.d.server.export_global(),
            paned_fd: raw(&paned),
            report_fd: raw(&report),
        };
        let state = write_state(&self.d.home, &st).map_err(|e| fail(go_error_string(&e)))?;
        let mut fds: Vec<u64> = tools.iter().map(|t| t.fd).collect();
        fds.extend([raw(&paned), raw(&report), raw(&state)]);
        Ok(Prepared {
            r: Arc::clone(self),
            exe,
            state,
            _paned: paned,
            _report: report,
            fds,
        })
    }
}

/// commit 직전까지 마친 교체다. 실패하면 rollback 이 모두 되돌린다. 버리면 연 파일이 닫힌다.
struct Prepared {
    r: Arc<Reloader>,
    exe: String,
    state: File,
    _paned: File,
    _report: File,
    fds: Vec<u64>,
}

impl Prepared {
    /// 넘길 fd 의 close-on-exec 를 지우고 exec 한다 (FR-DSK-13 5·7). 성공하면 돌아오지 않는다.
    /// 실패하면 모두 되돌린다 — 보고 연결에는 이미 성공을 답했으므로 `start` 가 확인으로 알아챈다
    /// (FR-DSK-17).
    fn commit(self) {
        for &fd in &self.fds {
            if let Err(e) = set_cloexec(fd, false) {
                let cause = format!("fd {fd} close-on-exec 해제: {}", go_error_string(&e));
                return self.rollback(&cause);
            }
        }
        let argv = vec![
            self.exe.clone(),
            "d".to_owned(),
            handover::ARG_FD.to_owned(),
            raw(&self.state).to_string(),
        ];
        infof!(
            None,
            "otterminald 교체 exec {} (도구 {}개)",
            self.exe,
            self.fds.len() - 3
        );
        let env: Vec<String> = std::env::vars_os()
            .map(|(k, v)| format!("{}={}", k.to_string_lossy(), v.to_string_lossy()))
            .collect();
        let err = (self.r.d.exec)(&self.exe, &argv, &env);
        self.rollback(&format!("exec: {}", go_error_string(&err)));
    }

    fn rollback(self, cause: &str) {
        errorf!(None, "otterminald 교체 실패 — 되돌린다: {cause}");
        for &fd in &self.fds {
            let _ = set_cloexec(fd, true);
        }
        let r = Arc::clone(&self.r);
        // 교체를 위해 연 파일은 닫는다. 도구 fd 는 도구의 것이므로 닫지 않는다.
        drop(self);
        r.d.tools.thaw_all();
        r.gate.leave();
    }
}

fn set_cloexec(fd: u64, on: bool) -> io::Result<()> {
    let fd = usize::try_from(fd).map_err(io::Error::other)?;
    otter_shared_platform::set_close_on_exec(fd, on)
}

#[cfg(unix)]
fn listener_files(s: &PanedServer) -> io::Result<(File, File)> {
    let (p, r) = s.listener_fds()?;
    Ok((File::from(p), File::from(r)))
}

#[cfg(not(unix))]
fn listener_files(_: &PanedServer) -> io::Result<(File, File)> {
    Err(io::Error::other("리스너를 fd 로 꺼낼 수 없다"))
}

#[cfg(unix)]
fn raw(f: &File) -> u64 {
    use std::os::fd::AsRawFd;
    u64::try_from(f.as_raw_fd()).unwrap_or_default()
}

#[cfg(windows)]
fn raw(f: &File) -> u64 {
    use std::os::windows::io::AsRawHandle;
    f.as_raw_handle() as u64
}
