//! Go 기준선 `otterminal/internal/daemon/boot` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! otterminald 프로세스의 진입점이다. 진입점 판별(`otterminal d` 또는 argv[0] 이 otterminald)은
//! composition root 의 책임이라 main 에 남고, 여기부터가 데몬 자신의 코드다.

mod edge;
mod sys;

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use otter_daemon_ipc::PanedServer;
use otter_daemon_swap as swap;
use otter_gocompat::oserr::{go_error_string, path_error};
use otter_shared_otterenv as otterenv;
use otter_shared_otterlog::{errorf, infof, warnf};
use otter_shared_toolhub::ToolManager;
use tokio_util::sync::CancellationToken;

pub use edge::start_edge;

/// workspace.json 의 탭이 가리키는 도구 id 다 (FR-EM-14). 파일이 없으면 빈 집합이다. 해석에
/// 실패해도 기록한 뒤 빈 집합이다 — 닿을 수 없는 셸을 되살리는 것이 빈 채로 뜨는 것보다 나쁘다.
pub fn referenced_tools(path: &Path) -> HashSet<String> {
    let blob = match read_file(path) {
        Ok(b) => b,
        Err(e) => {
            if e.kind() != io::ErrorKind::NotFound {
                infof!(None, "workspace 읽기: {}", go_error_string(&e));
            }
            return HashSet::new();
        }
    };
    match otter_shared_workspace::referenced_tool_ids(&blob) {
        Ok(refs) => refs,
        Err(e) => {
            errorf!(
                None,
                "workspace 참조 해석 실패 — 도구를 복원하지 않습니다: {e}"
            );
            HashSet::new()
        }
    }
}

/// Go `os.ReadFile` 처럼 여는 실패는 `open`, 읽는 실패는 `read` 의 PathError 로 낸다.
fn read_file(path: &Path) -> io::Result<Vec<u8>> {
    use std::io::Read;
    let name = path.to_string_lossy();
    let mut f = std::fs::File::open(path).map_err(|e| path_error("open", &name, e))?;
    let mut b = Vec::new();
    f.read_to_end(&mut b)
        .map_err(|e| path_error("read", &name, e))?;
    Ok(b)
}

/// otterminald 의 진입점이다 (DAEMON_SPLIT_SRS Phase 2). 도구 관리자를 세우고 tools.json 을
/// 읽은 뒤 소켓을 듣는다. 종료 신호를 받으면 저장하고 돌아온다. 기동에 실패하면 Go 처럼
/// 종료 코드 1 로 프로세스를 끝낸다.
///
/// version 은 이 바이너리의 판(샌드박스 헬퍼·`hello`), daemon_build 는 데몬 코드의 지문이다
/// (FR-DFP-4/6). handover_fd 가 0 보다 크면 세션 유지 교체로 뜬 것이다 (FR-DSK-20).
pub fn run(home: &str, version: &str, daemon_build: &str, handover_fd: i64) {
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            errorf!(None, "otterminald runtime: {}", go_error_string(&e));
            std::process::exit(1);
        }
    };
    {
        let _enter = rt.enter();
        serve(home, version, daemon_build, handover_fd);
    }
    // Go 의 main 이 돌아오면 남은 goroutine 은 함께 끝난다.
    rt.shutdown_background();
}

fn serve(home: &str, version: &str, daemon_build: &str, handover_fd: i64) {
    infof!(
        None,
        "otterminald starting home={home} handover={}",
        handover_fd > 0
    );
    let home_path = PathBuf::from(home);

    // FR-PRF-78: 점검만 한다. 없거나 깨졌을 때만 깐다.
    if let Err(e) = otter_shared_runtime::ensure_installed(&home_path.join(otterenv::BIN_DIR)) {
        errorf!(None, "runtime install: {}", go_error_string(&e));
        std::process::exit(1);
    }

    let pm = Arc::new(ToolManager::new(home, None));
    // Go 의 데몬은 main 이 `os.Setenv(OTTERMINAL_HOME, home)` 한 프로세스 환경에서 도구를 띄운다.
    pm.set_env_overlay(vec![(otterenv::ENV_HOME.to_owned(), home.to_owned())]);
    // FR-SBX-10: 데몬이 PTY 를 가지므로 샌드박스 배치도 여기서 한다. 포트는 넘기지 않는다
    // (FR-HRB-13).
    if let Some(pl) = otter_shared_sandboxplace::wire(home, version, "") {
        pm.set_placer(pl.placer_fn());
    }
    // FR-HLM-3: 헤드리스 멤버의 도구는 Run 이 소유한다.
    let owned_home = home_path.clone();
    pm.set_owned_tools(Arc::new(move || {
        otter_shared_runfile::headless_tool_ids(&owned_home)
    }));

    let platform = otter_shared_platform::current();
    let sock_path = platform.ipc.endpoint(&home_path);
    let pid_path = home_path.join(otterenv::PANED_PID_FILE);
    // AGENT_RECORD_DAEMON_SRS §3.3a: 알림은 도구를 만들 때 실리므로 load_all 보다 먼저 만든다.
    let ps = PanedServer::new(Arc::clone(&pm), &sock_path, Some(&pid_path));

    let inherited = read_handover(handover_fd);
    if let Some(st) = &inherited {
        swap::restore(&pm, &ps, st);
    }
    // FR-DSK-26: exec 로 뜬 데몬은 인계 상태로 못 되살린 셸을 되찾거나 입양한다.
    if handover_fd > 0 {
        let refs = referenced_tools(&home_path.join(otterenv::WORKSPACE_FILE));
        match swap::find_orphans(&pm.master_fds()) {
            Err(e) => errorf!(None, "되찾을 셸을 찾지 못했다: {}", go_error_string(&e)),
            Ok(orphans) if !orphans.is_empty() => {
                let (recovered, adopted) = swap::recover(&pm, &home_path, &refs, &orphans);
                infof!(
                    None,
                    "인계 상태 밖의 셸: 되찾음 {recovered}개, 입양 {adopted}개"
                );
            }
            Ok(_) => {}
        }
    }
    if inherited.is_none() {
        restore_from_file(&home_path, &pm);
    }

    // FR-VHL-1, FR-DFP-4.
    ps.set_build_version(version);
    ps.set_daemon_build(
        &home_path.join(otter_shared_toolipc::DAEMON_BUILD_FILE),
        daemon_build,
    );
    listen(&home_path, &ps, inherited.as_ref());
    // DAEMON_SESSION_KEEP_SRS: Windows 는 교체기가 거절한다 (D-DSK-7).
    let reloader = swap::Reloader::new(swap::Deps {
        home: home_path.clone(),
        tools: Arc::clone(&pm),
        server: ps.clone(),
        env: swap::Env {
            euid: sys::euid(),
            goos: platform.os.as_str().to_owned(),
            self_exe: sys::self_exe(),
        },
        preflight: None,
        exec: Arc::new(sys::exec),
    });
    ps.set_reloader(Some(reloader.into_ipc()));

    // PEER_DAEMON_SRS §3.5a: 데몬이 노드다.
    let close_edge = start_edge(&home_path, &ps, &pm);

    let shutdown = CancellationToken::new();
    let signals = sys::shutdown_signals(platform.process.shutdown_signals());
    {
        let shutdown = shutdown.clone();
        let ps = ps.clone();
        tokio::spawn(async move {
            signals.await;
            shutdown.cancel();
            let _ = tokio::task::spawn_blocking(move || {
                close_edge();
                ps.close();
            })
            .await;
        });
    }

    // FR-OPT-2-1: 전경 조회는 이 프로세스가 돌린다.
    pm.spawn_foreground_refresh(shutdown.clone());
    // FR-ARD-30: 유휴 판정도 데몬이 한다.
    pm.spawn_attention_sweeper(shutdown.clone());
    // PERF D-50·D-53: 출력이 멎은 도구의 에뮬레이터 기록을 줄 저장소로 옮겨 비운다.
    pm.spawn_screen_compactor(shutdown.clone());

    infof!(
        None,
        "otterminald listening on {} (platform={})",
        sock_path.display(),
        platform.os
    );

    // 연결은 하나씩 처리한다. 끊기면 다음 otterminal 의 연결을 기다린다.
    loop {
        let Err(e) = ps.accept() else { continue };
        if shutdown.is_cancelled() {
            infof!(
                None,
                "otterminald shutting down, saving {} tools...",
                pm.snapshot().len()
            );
            // 문을 닫고 인플라이트 저장을 거둔 뒤에 마지막 상태를 쓴다.
            pm.stop_saving();
            pm.save_all();
            return;
        }
        infof!(None, "otterminald accept: {}", go_error_string(&e));
    }
}

/// 교체로 넘겨받은 인계 상태다. 일반 기동이거나 읽지 못하면 None 이다.
fn read_handover(fd: i64) -> Option<swap::State> {
    if fd <= 0 {
        return None;
    }
    match sys::handover_file(fd).and_then(swap::read_state) {
        Ok(st) => Some(st),
        Err(e) => {
            errorf!(None, "인계 상태를 읽지 못했다 — 일반 기동으로 간다: {e}");
            None
        }
    }
}

/// 일반 기동의 복원이다 — tools.json 에서 탭이 가리키는 도구를 빈 셸로 되살린다.
fn restore_from_file(home: &Path, pm: &ToolManager) {
    let mut refs = referenced_tools(&home.join(otterenv::WORKSPACE_FILE));
    let headless = otter_shared_runfile::headless_tool_ids(home);
    refs.extend(headless.iter().cloned());
    // 되찾은 셸(FR-DSK-27)은 이미 있다. 같은 id 로 빈 셸을 만들면 그 도구를 덮는다.
    refs.retain(|id| pm.get(id).is_none());
    pm.load_all(&refs);
    // 백그라운드 등록은 tools.json 에 없다. 되돌리지 않으면 닿을 수 없는 도구가 된다 (FR-BGR-5).
    for id in &headless {
        pm.set_background(id, true);
    }
    if !headless.is_empty() {
        infof!(
            None,
            "헤드리스 도구 {}개를 백그라운드로 복원",
            headless.len()
        );
    }
}

/// 두 소켓을 연다. 인계 상태가 있으면 넘겨받은 리스너를 쓰고, 못 쓰면 새로 연다 (FR-DSK-24).
fn listen(home: &Path, ps: &PanedServer, inherited: Option<&swap::State>) {
    let report_path = otter_shared_agentrec::socket_path(home);
    if let Some(st) = inherited {
        match swap::inherit_listeners(st) {
            Ok((paned, report)) => {
                ps.listen_inherited(paned, report, &report_path);
                serve_reports(ps);
                return;
            }
            Err(e) => errorf!(
                None,
                "넘겨받은 소켓을 쓰지 못했다 — 새로 연다: {}",
                go_error_string(&e)
            ),
        }
    }
    // FR-DSK-26: 쓰지 못한 물려받은 리스너가 남아 있으면 listen 의 안전 검사가 그 소켓에 붙어
    // "다른 데몬이 있다" 로 보고 끝난다. 그 fd 를 먼저 닫는다.
    let endpoint = otter_shared_platform::current().ipc.endpoint(home);
    let n = swap::close_inherited_sockets(&[
        &endpoint.to_string_lossy(),
        &report_path.to_string_lossy(),
    ]);
    if n > 0 {
        warnf!(None, "쓰지 못한 물려받은 소켓 fd {n}개를 닫았다");
    }
    if let Err(e) = ps.listen() {
        errorf!(None, "otterminald listen: {}", go_error_string(&e));
        std::process::exit(1);
    }
    // FR-ARD-20: 보고 소켓을 열지 못해도 기동은 막지 않는다 (FR-ARD-23).
    match ps.listen_reports(&report_path) {
        Err(e) => errorf!(None, "otterminald 보고 소켓: {}", go_error_string(&e)),
        Ok(()) => serve_reports(ps),
    }
}

fn serve_reports(ps: &PanedServer) {
    let ps = ps.clone();
    std::thread::spawn(move || ps.serve_reports());
}

#[cfg(test)]
mod tests;
