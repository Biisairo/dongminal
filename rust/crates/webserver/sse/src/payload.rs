use serde::Serialize;

/// 방송 본문의 봉투다. 키 순서가 Go `json.Marshal(map{action,args})` 와 같다.
/// args 가 `None` 이면 키를 싣지 않는다.
#[derive(Serialize)]
struct Event<'a, T: ?Sized> {
    action: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    args: Option<&'a T>,
}

/// `{"action":…,"args":…}` 본문이다 (IPC-20). 직렬화에 실패하면 로그를 남기고 action 만 싣는다.
pub fn payload<T: Serialize + ?Sized>(action: &str, args: Option<&T>) -> Vec<u8> {
    match dm_gocompat::json::marshal(&Event { action, args }) {
        Ok(b) => b,
        Err(e) => {
            dm_shared_dmlog::errorf!(None, "[sse] {action} 본문 직렬화 실패 — args 를 뺀다: {e}");
            dm_gocompat::json::marshal(&Event::<()> { action, args: None }).unwrap_or_default()
        }
    }
}

#[derive(Serialize)]
struct Rev {
    rev: u64,
}

/// `workspace_changed` 본문이다.
pub fn workspace_changed(rev: u64) -> Vec<u8> {
    payload("workspace_changed", Some(&Rev { rev }))
}
