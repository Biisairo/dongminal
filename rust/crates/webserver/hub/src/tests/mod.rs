mod attn;
mod commands;
mod focus_seats;
mod gitwatch;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;

use crate::{CmdResult, CmdSub, CommandBroker, lock};

/// 방송을 받아 적는 대역이다.
#[derive(Default)]
pub(crate) struct FakeBroker {
    pub(crate) sent: Mutex<Vec<Vec<u8>>>,
    pub(crate) on_broadcast: Mutex<Option<Box<dyn Fn() + Send>>>,
}

impl FakeBroker {
    pub(crate) fn new() -> Arc<FakeBroker> {
        Arc::new(FakeBroker::default())
    }
    pub(crate) fn count(&self) -> usize {
        lock(&self.sent).len()
    }
    pub(crate) fn sent(&self) -> Vec<String> {
        lock(&self.sent)
            .iter()
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect()
    }
    pub(crate) fn reset(&self) {
        lock(&self.sent).clear();
    }
}

impl CommandBroker for FakeBroker {
    fn add(&self) -> Option<Arc<CmdSub>> {
        None
    }
    fn remove(&self, _: &Arc<CmdSub>) {}
    fn broadcast(&self, payload: &[u8]) -> usize {
        if let Some(f) = lock(&self.on_broadcast).as_ref() {
            f();
        }
        lock(&self.sent).push(payload.to_vec());
        1
    }
    fn broadcast_and_await<'a>(
        &'a self,
        _: &'a [u8],
        _: &'a str,
        _: Duration,
    ) -> BoxFuture<'a, (CmdResult, usize, bool)> {
        Box::pin(async { (CmdResult::default(), 0, false) })
    }
    fn deliver_result(&self, _: &str, _: CmdResult) {}
}
