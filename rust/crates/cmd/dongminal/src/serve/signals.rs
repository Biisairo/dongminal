//! 서버의 종료 신호다 (Go `signal.NotifyContext(…, platform.Current().Process.ShutdownSignals()…)`).

use std::future::Future;
use std::io;
use std::pin::Pin;

use dm_shared_dmlog::errorf;
use dm_shared_platform::ShutdownSignal;

type Wait = Pin<Box<dyn Future<Output = ()> + Send>>;

/// sigs 중 하나가 오면 끝나는 future 다. 지금 등록하므로 돌려준 뒤에 온 신호를 놓치지 않는다.
/// tokio 런타임 안에서 부른다.
pub(super) fn shutdown_signals(sigs: &[ShutdownSignal]) -> Wait {
    let mut waits: Vec<Wait> = Vec::new();
    for &s in sigs {
        match listen_signal(s) {
            Ok(w) => waits.push(w),
            Err(e) => errorf!(None, "signal {s:?}: {e}"),
        }
    }
    if waits.is_empty() {
        return Box::pin(std::future::pending());
    }
    Box::pin(std::future::poll_fn(move |cx| {
        if waits.iter_mut().any(|w| w.as_mut().poll(cx).is_ready()) {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    }))
}

#[cfg(unix)]
fn listen_signal(s: ShutdownSignal) -> io::Result<Wait> {
    use tokio::signal::unix::{SignalKind, signal};
    let kind = match s {
        ShutdownSignal::Interrupt => SignalKind::interrupt(),
        ShutdownSignal::Terminate => SignalKind::terminate(),
        ShutdownSignal::Hangup => SignalKind::hangup(),
    };
    let mut sig = signal(kind)?;
    Ok(Box::pin(async move {
        sig.recv().await;
    }))
}

#[cfg(windows)]
fn listen_signal(s: ShutdownSignal) -> io::Result<Wait> {
    use tokio::signal::windows::{ctrl_break, ctrl_c};
    match s {
        ShutdownSignal::Interrupt => {
            let mut c = ctrl_c()?;
            let mut b = ctrl_break()?;
            Ok(Box::pin(async move {
                tokio::select! {
                    _ = c.recv() => {}
                    _ = b.recv() => {}
                }
            }))
        }
        ShutdownSignal::Terminate | ShutdownSignal::Hangup => Ok(Box::pin(std::future::pending())),
    }
}
