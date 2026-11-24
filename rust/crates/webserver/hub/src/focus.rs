//! Window 포커스 소유권 (USER_CHECKLIST_FIXES_SRS §3.5, FR-XDF-*).
//!
//! 한 Window 를 어느 Client 가 보는지를 서버가 권위로 든다. 디스크에 남기지 않는다 —
//! 재시작하면 모두 풀린다 (FR-XDF-1).

use std::collections::HashMap;
use std::sync::Mutex;

use crate::lock;

#[derive(Default)]
struct Focus {
    /// windowId → clientId
    owners: HashMap<String, String>,
    /// clientId → 가장 새 SSE 구독의 epoch (FR-XDF-10).
    live: HashMap<String, u64>,
    epoch: u64,
    /// clientId → 가장 새 포커스 주장의 순번 (FR-SXE-4).
    claimed: HashMap<String, u64>,
    claim_seq: u64,
    /// clientId → 가장 새 구독의 원격 주소 (FR-VUO-1). 모르면 없다.
    addrs: HashMap<String, String>,
}

impl Focus {
    fn executor(&self) -> String {
        let mut best: Option<(&String, u64)> = None;
        for cid in self.live.keys() {
            let c = self.claimed.get(cid).copied().unwrap_or(0);
            if c > best.map_or(0, |b| b.1) {
                best = Some((cid, c));
            }
        }
        if let Some((cid, _)) = best {
            return cid.clone();
        }
        self.live
            .iter()
            .min_by_key(|(_, ep)| **ep)
            .map(|(cid, _)| cid.clone())
            .unwrap_or_default()
    }
}

#[derive(Default)]
pub struct FocusRegistry {
    mu: Mutex<Focus>,
}

impl FocusRegistry {
    pub fn new() -> FocusRegistry {
        FocusRegistry::default()
    }

    /// 지금 소유 맵의 사본이다 (FR-XDF-7).
    pub fn snapshot(&self) -> HashMap<String, String> {
        lock(&self.mu).owners.clone()
    }

    /// clientId 를 windowId 의 주인으로 세우고 그 클라이언트의 다른 창을 놓는다 (FR-XDF-2·3).
    /// 바뀐 것이 있는지 돌려준다.
    pub fn claim(&self, client_id: &str, window_id: &str) -> bool {
        if client_id.is_empty() || window_id.is_empty() {
            return false;
        }
        let mut f = lock(&self.mu);
        let before = f.owners.len();
        f.owners
            .retain(|wid, owner| wid == window_id || owner != client_id);
        let mut changed = f.owners.len() != before;
        if f.owners.get(window_id).map(String::as_str) != Some(client_id) {
            f.owners.insert(window_id.to_owned(), client_id.to_owned());
            changed = true;
        }
        // 변화가 있을 때만 최신성을 갱신한다 (FR-XDF-14).
        if changed {
            f.claim_seq += 1;
            let seq = f.claim_seq;
            f.claimed.insert(client_id.to_owned(), seq);
        }
        changed
    }

    /// 생성 명령을 수행할 클라이언트 하나다 (FR-SXE-4). 살아 있는 구독 중 가장 최근에
    /// 포커스를 주장한 쪽, 없으면 가장 오래된 구독이다. 구독이 없으면 빈 문자열이다.
    pub fn executor(&self) -> String {
        lock(&self.mu).executor()
    }

    /// 뽑힌 뷰어와 그 구독의 원격 주소를 한 락 안에서 함께 낸다 (FR-VUO-1·4).
    pub fn executor_addr(&self) -> (String, String) {
        let f = lock(&self.mu);
        let cid = f.executor();
        if cid.is_empty() {
            return (String::new(), String::new());
        }
        let addr = f.addrs.get(&cid).cloned().unwrap_or_default();
        (cid, addr)
    }

    /// 지금 붙어 있는 구독 수다 (FR-VUO-19).
    pub fn live_count(&self) -> usize {
        lock(&self.mu).live.len()
    }

    pub fn attach(&self, client_id: &str) -> u64 {
        self.attach_from(client_id, "")
    }

    /// 살아 있는 구독을 등록하고 epoch 를 돌려준다. 원격 주소를 함께 남긴다 (FR-VUO-1).
    pub fn attach_from(&self, client_id: &str, remote_addr: &str) -> u64 {
        if client_id.is_empty() {
            return 0;
        }
        let mut f = lock(&self.mu);
        f.epoch += 1;
        let ep = f.epoch;
        f.live.insert(client_id.to_owned(), ep);
        if remote_addr.is_empty() {
            f.addrs.remove(client_id);
        } else {
            f.addrs.insert(client_id.to_owned(), remote_addr.to_owned());
        }
        ep
    }

    /// ep 가 그 클라이언트의 가장 새 구독일 때만 그 클라이언트의 창을 모두 놓는다
    /// (FR-XDF-9·10). 바뀐 것이 있는지 돌려준다.
    pub fn detach(&self, client_id: &str, ep: u64) -> bool {
        if client_id.is_empty() || ep == 0 {
            return false;
        }
        let mut f = lock(&self.mu);
        if f.live.get(client_id) != Some(&ep) {
            return false;
        }
        f.live.remove(client_id);
        f.claimed.remove(client_id);
        f.addrs.remove(client_id);
        let before = f.owners.len();
        f.owners.retain(|_, owner| owner != client_id);
        f.owners.len() != before
    }
}
