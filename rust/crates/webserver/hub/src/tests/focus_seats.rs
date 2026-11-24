use std::sync::{Arc, Mutex};

use futures_util::future::BoxFuture;
use tokio_tungstenite::tungstenite::Error as WsError;

use crate::*;

#[test]
fn focus_claim_and_detach() {
    let f = FocusRegistry::new();
    assert!(!f.claim("", "w1") && !f.claim("c1", ""));
    assert!(f.claim("c1", "w1"));
    assert!(!f.claim("c1", "w1"), "같은 주장은 바뀐 것이 없다");
    assert!(f.claim("c1", "w2"), "한 클라이언트는 창 하나만 가진다");
    assert_eq!(f.snapshot().len(), 1);
    assert!(f.claim("c2", "w2"), "마지막 포커스가 이긴다");
    assert_eq!(f.snapshot().get("w2").map(String::as_str), Some("c2"));
    let ep1 = f.attach("c2");
    let ep2 = f.attach("c2");
    assert!(
        !f.detach("c2", ep1),
        "옛 구독의 정리는 새 소유를 풀지 않는다"
    );
    assert!(f.detach("c2", ep2));
    assert!(f.snapshot().is_empty());
    assert!(!f.detach("c2", 0));
}

#[test]
fn executor_addr_elected_viewer() {
    let f = FocusRegistry::new();
    assert_eq!(f.executor_addr(), (String::new(), String::new()));
    assert_eq!(f.executor(), "");
    f.attach_from("old", "10.0.0.1:1");
    f.attach_from("new", "127.0.0.1:2");
    // 아무도 주장하지 않았으면 가장 오래된 구독이다.
    assert_eq!(f.executor_addr(), ("old".into(), "10.0.0.1:1".into()));
    f.claim("new", "w1");
    assert_eq!(f.executor_addr(), ("new".into(), "127.0.0.1:2".into()));
    assert_eq!(f.live_count(), 2);
    // 주소 없는 Attach 는 옛 주소를 지운다.
    f.attach("new");
    assert_eq!(f.executor_addr(), ("new".into(), String::new()));
    let ep = f.attach_from("new", "127.0.0.1:3");
    f.detach("new", ep);
    assert_eq!(f.executor_addr(), ("old".into(), "10.0.0.1:1".into()));
    assert_eq!(f.attach(""), 0);
}

#[derive(Default)]
struct Rec {
    got: Mutex<Vec<u8>>,
    fail: bool,
}

impl SeatConn for Rec {
    fn send<'a>(&'a self, op: u8, payload: &'a [u8]) -> BoxFuture<'a, Result<(), WsError>> {
        Box::pin(async move {
            assert_eq!(op, otter_shared_toolhub::OP_REPLY_SEAT);
            crate::lock(&self.got).push(payload[0]);
            if self.fail {
                Err(WsError::ConnectionClosed)
            } else {
                Ok(())
            }
        })
    }
}

fn last(r: &Rec) -> Option<u8> {
    crate::lock(&r.got).last().copied()
}

#[tokio::test]
async fn reply_seats_succession() {
    let s = ReplySeats::new();
    let a = Arc::new(Rec {
        fail: true,
        ..Default::default()
    });
    let b = Arc::new(Rec::default());
    let c = Arc::new(Rec::default());
    let (da, db, dc): (Arc<dyn SeatConn>, Arc<dyn SeatConn>, Arc<dyn SeatConn>) =
        (a.clone(), b.clone(), c.clone());
    s.join("t", da.clone()).await;
    assert_eq!(last(&a), Some(1), "처음 붙은 쪽이 주인이다");
    s.join("t", db.clone()).await;
    assert_eq!(
        (last(&a), last(&b)),
        (Some(1), Some(0)),
        "실패한 통보가 다른 쪽을 막지 않는다"
    );
    s.join("other", dc.clone()).await;
    assert_eq!(last(&c), Some(1), "도구마다 따로다");
    s.leave("t", &db).await;
    assert_eq!(last(&a), Some(1), "주인 아닌 쪽이 떠나도 좌석은 그대로다");
    s.join("t", db.clone()).await;
    s.leave("t", &da).await;
    assert_eq!(last(&b), Some(1), "주인이 떠나면 다음이 잇는다");
    let n = crate::lock(&b.got).len();
    s.leave("nope", &da).await;
    s.leave("t", &da).await;
    assert_eq!(crate::lock(&b.got).len(), n + 1);
}
