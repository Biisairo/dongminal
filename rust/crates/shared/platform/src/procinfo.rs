//! 프로세스·포트에 대한 읽기 전용 조회 (FR-XPI-1). 구현은 이슈 1.4.4 가 채운다.
//!
//! 조회는 모두 실패할 수 있고, 실패는 오류가 아니라 "모름" 이다 (NFR-XP-6).

use std::collections::HashMap;

/// 프로세스·포트 조회.
pub trait ProcInfo: Send + Sync {
    /// pid 에 직계 자식이 있는지. 읽지 못하면 false.
    fn has_children(&self, pid: i32) -> bool;
    /// pid 들의 has_children 을 한 번에 (FR-OPT-8-3).
    fn children_of(&self, pids: &[i32]) -> HashMap<i32, bool>;
    /// 현재 작업 디렉터리.
    fn cwd(&self, pid: i32) -> Option<String>;
    /// pid 들의 cwd 를 한 번에 (FR-PRF-76). 읽지 못한 pid 는 표에 없다.
    fn cwds(&self, pids: &[i32]) -> HashMap<i32, String>;
    /// pid 들의 프로세스 이름을 한 번에.
    fn names(&self, pids: &[i32]) -> HashMap<i32, String>;
    /// TCP 포트를 LISTEN 으로 점유한 pid 들. 접속만 한 클라이언트는 넣지 않는다.
    fn listener_pids(&self, port: &str) -> Vec<i32>;
    /// pid 의 부모 (FR-XPI-7).
    fn parent_pid(&self, pid: i32) -> Option<i32>;
    /// 모든 프로세스의 pid → 부모 pid 표 (FR-RRC-10). 읽지 못하면 None — 빈 표와 "모름" 을 가른다.
    fn parents(&self) -> Option<HashMap<i32, i32>>;
    /// 이 서버에 붙은 로컬 TCP 연결의 반대쪽 끝을 소유한 프로세스. remote_addr 는 "host:port".
    fn connection_owner_pid(&self, remote_addr: &str) -> Option<i32>;
}

struct Pending;

impl ProcInfo for Pending {
    fn has_children(&self, _: i32) -> bool {
        false
    }
    fn children_of(&self, _: &[i32]) -> HashMap<i32, bool> {
        HashMap::new()
    }
    fn cwd(&self, _: i32) -> Option<String> {
        None
    }
    fn cwds(&self, _: &[i32]) -> HashMap<i32, String> {
        HashMap::new()
    }
    fn names(&self, _: &[i32]) -> HashMap<i32, String> {
        HashMap::new()
    }
    fn listener_pids(&self, _: &str) -> Vec<i32> {
        Vec::new()
    }
    fn parent_pid(&self, _: i32) -> Option<i32> {
        None
    }
    fn parents(&self) -> Option<HashMap<i32, i32>> {
        None
    }
    fn connection_owner_pid(&self, _: &str) -> Option<i32> {
        None
    }
}

pub(crate) fn current() -> &'static dyn ProcInfo {
    &Pending
}
