use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use super::*;

#[derive(Default)]
struct Fake {
    sent: Mutex<Vec<String>>,
    err: Mutex<Option<fn() -> SendError>>,
}

impl Fake {
    fn sender(self: &Arc<Self>) -> Sender {
        let f = self.clone();
        Box::new(move |kind, tool, v| {
            if let Some(mk) = *lock(&f.err) {
                return Err(mk());
            }
            lock(&f.sent).push(format!("{kind}/{tool}={}", String::from_utf8_lossy(&v.0)));
            Ok(())
        })
    }
    fn got(&self) -> Vec<String> {
        lock(&self.sent).clone()
    }
    fn set_err(&self, e: Option<fn() -> SendError>) {
        *lock(&self.err) = e;
    }
}

fn lost() -> SendError {
    "paned connection lost".into()
}

fn not_found() -> SendError {
    Box::new(RpcError {
        code: CODE_NOT_FOUND,
        message: "no tool".into(),
    })
}

#[test]
fn coalesces_per_key() {
    let f = Arc::new(Fake::default());
    let w = Writer::new(f.sender());
    w.put("usage", "t1", &BTreeMap::from([("a", 1)]));
    w.put("usage", "t1", &BTreeMap::from([("a", 2)]));
    w.put("limits", "", &());
    w.flush();
    let mut got = f.got();
    got.sort();
    assert_eq!(got, vec!["limits/=null", r#"usage/t1={"a":2}"#]);
    w.flush();
    assert_eq!(f.got().len(), 2, "보낸 값을 다시 보냈다");
}

#[test]
fn transient_kept_until_flush() {
    let f = Arc::new(Fake::default());
    f.set_err(Some(lost));
    let w = Writer::new(f.sender());
    w.put("usage", "t1", &1);
    w.flush();
    f.set_err(None);
    w.flush();
    assert_eq!(f.got(), vec!["usage/t1=1"]);
}

#[test]
fn transient_does_not_overwrite_newer() {
    let cell: Arc<OnceLock<Arc<Writer>>> = Arc::new(OnceLock::new());
    let calls = Arc::new(Mutex::new(0));
    let (c2, cl2) = (cell.clone(), calls.clone());
    let w = Writer::new(Box::new(move |kind, tool, _| {
        let mut n = lock(&cl2);
        *n += 1;
        if *n == 1 {
            c2.get().unwrap().put(kind, tool, &2);
            return Err("lost".into());
        }
        Ok(())
    }));
    let _ = cell.set(w.clone());
    w.put("usage", "t1", &1);
    w.flush();
    assert_eq!(w.pending_of("usage", "t1").as_deref(), Some(&b"2"[..]));
}

#[test]
fn rpc_error_dropped() {
    let f = Arc::new(Fake::default());
    f.set_err(Some(not_found));
    let w = Writer::new(f.sender());
    w.put("usage", "gone", &1);
    w.flush();
    f.set_err(None);
    w.flush();
    assert!(f.got().is_empty(), "데몬이 거절한 값을 다시 보냈다");
}

#[tokio::test]
async fn start_sends_in_background() {
    let f = Arc::new(Fake::default());
    let w = Writer::new(f.sender());
    let stop = CancellationToken::new();
    w.start(stop.clone());
    w.put("usage", "t1", &1);
    let deadline = Instant::now() + Duration::from_secs(2);
    while f.got().is_empty() {
        assert!(Instant::now() < deadline, "배경 작업이 보내지 않았다");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    stop.cancel();
}
