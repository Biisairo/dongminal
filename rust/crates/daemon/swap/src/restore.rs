use std::io;

use otter_daemon_ipc::PanedServer;
use otter_gocompat::oserr::go_error_string;
use otter_shared_otterlog::{errorf, infof};
use otter_shared_platform::IpcListener;
use otter_shared_toolhub::{HandoverTool, ToolManager};

use crate::state::State;

/// 인계 상태의 도구와 데몬 전체 기록을 되살린다 (FR-DSK-20~23). 되살리지 못한 도구를 돌려준다 —
/// 그 도구의 셸은 되찾기(FR-DSK-27)가 맡는다.
pub fn restore(pm: &ToolManager, ps: &PanedServer, st: &State) -> Vec<HandoverTool> {
    let tools = st.tools.as_deref().unwrap_or_default();
    let mut failed = Vec::new();
    for t in tools {
        if let Err(e) = pm.adopt_handover(t.clone()) {
            errorf!(None, "인계 도구를 되살리지 못했다: {}", go_error_string(&e));
            failed.push(t.clone());
        }
    }
    ps.import_global(&st.global);
    infof!(
        None,
        "인계 상태로 되살림: 도구 {}개, 실패 {}개",
        tools.len() - failed.len(),
        failed.len()
    );
    failed
}

/// 인계 상태의 두 리스너 fd 로 리스너를 만든다 (FR-DSK-24). 하나라도 실패하면 둘 다 닫는다 —
/// 호출자는 일반 listen 으로 돌아간다. 두 fd 의 소유권을 가져간다.
#[cfg(unix)]
pub fn inherit_listeners(st: &State) -> io::Result<(IpcListener, IpcListener)> {
    let fd = |v: u64| i32::try_from(v).map_err(io::Error::other);
    let paned = IpcListener::from_inherited_fd(fd(st.paned_fd)?)?;
    let report = IpcListener::from_inherited_fd(fd(st.report_fd)?)?;
    Ok((paned, report))
}

#[cfg(not(unix))]
pub fn inherit_listeners(_: &State) -> io::Result<(IpcListener, IpcListener)> {
    Err(io::Error::other(
        "이 OS 는 세션 유지 교체를 지원하지 않습니다",
    ))
}
