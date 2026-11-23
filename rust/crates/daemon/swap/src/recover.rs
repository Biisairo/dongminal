//! 되찾기와 입양 (DAEMON_SESSION_KEEP_SRS FR-DSK-26~28).
//!
//! exec 뒤의 새 데몬은 인계 상태를 잃어도 PTY 마스터 fd 와 자식 셸을 여전히 쥐고 있다. 둘을
//! 단말 이름으로 짝짓고, tools.json 에 적힌 셸 pid 로 어느 도구인지 안다 (D-DSK-14).

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::Path;

use dm_gocompat::json;
use dm_gocompat::oserr::go_error_string;
use dm_shared_dmlog::{errorf, infof, warnf};
use dm_shared_toolhub::{DEFAULT_COLS, DEFAULT_ROWS, HandoverTool, ToolManager, ToolState};

/// 인계 상태 없이 찾은 셸 하나다.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Orphan {
    pub fd: usize,
    pub pid: i32,
}

/// 이 프로세스가 쥔 PTY 마스터 fd 중 claimed 에 없는 것을 직계 자식 셸과 짝짓는다 (FR-DSK-27 1·2).
pub fn find_orphans(claimed: &HashSet<usize>) -> io::Result<Vec<Orphan>> {
    let masters = dm_shared_platform::pty_masters(claimed)?;
    if masters.is_empty() {
        return Ok(Vec::new());
    }
    let children = dm_shared_platform::child_ttys(i32::try_from(std::process::id()).unwrap_or(0))?;
    let mut out = Vec::new();
    let mut taken = HashSet::new();
    for c in children {
        let Some(&fd) = masters.get(&c.tty) else {
            continue;
        };
        if taken.insert(fd) {
            out.push(Orphan { fd, pid: c.pid });
        }
    }
    Ok(out)
}

/// 찾은 셸을 도구로 되세운다. tools.json 에 그 pid 가 적혀 있고 아직 없는 도구면 같은 id 로
/// 되찾고 (FR-DSK-27 3~5), 아니면 새 id 의 백그라운드 도구로 입양한다 (FR-DSK-28). 어느 탭도
/// 가리키지 않는 되찾은 도구도 백그라운드다. (되찾은 수, 입양한 수) 를 돌려준다.
pub fn recover(
    pm: &ToolManager,
    home: &Path,
    refs: &HashSet<String>,
    orphans: &[Orphan],
) -> (usize, usize) {
    let by_pid: HashMap<i64, ToolState> = tool_states(home)
        .into_iter()
        .filter(|s| s.pid > 0)
        .map(|s| (s.pid, s))
        .collect();
    let (mut recovered, mut adopted) = (0, 0);
    for o in orphans {
        let mut ht = HandoverTool {
            fd: o.fd as u64,
            pid: i64::from(o.pid),
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
            ..HandoverTool::default()
        };
        let known = match by_pid.get(&i64::from(o.pid)) {
            Some(s) if pm.get(&s.id).is_none() => {
                ht.id.clone_from(&s.id);
                ht.name.clone_from(&s.name);
                ht.cwd.clone_from(&s.cwd);
                ht.background = !refs.contains(&s.id);
                true
            }
            _ => {
                ht.id = dm_shared_uuid::new_string();
                ht.name = dm_shared_platform::command_name(o.pid);
                ht.background = true;
                false
            }
        };
        let id = ht.id.clone();
        if let Err(e) = pm.adopt_handover(ht) {
            errorf!(
                None,
                "셸 pid={} 를 되찾지 못했다: {}",
                o.pid,
                go_error_string(&e)
            );
            continue;
        }
        if known {
            recovered += 1;
            infof!(None, "[tool {id}] 인계 상태 없이 되찾음 pid={}", o.pid);
        } else {
            adopted += 1;
            warnf!(
                None,
                "[tool {id}] 어느 도구인지 모르는 셸을 백그라운드로 입양 pid={}",
                o.pid
            );
        }
    }
    (recovered, adopted)
}

/// tools.json 의 도구들이다. 읽지 못하면 빈 목록이다.
fn tool_states(home: &Path) -> Vec<ToolState> {
    let Ok(blob) = std::fs::read(home.join(dm_shared_dmenv::TOOLS_FILE)) else {
        return Vec::new();
    };
    json::unmarshal::<Option<Vec<ToolState>>>(&blob)
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// paths 에 묶인 유닉스 소켓 fd 를 모두 닫고 그 수를 돌려준다 (FR-DSK-26). exec 로 넘어왔으나
/// 쓰지 못한 리스너가 대상이다.
pub fn close_inherited_sockets(paths: &[&str]) -> usize {
    dm_shared_platform::close_sockets_bound_to(paths)
}
