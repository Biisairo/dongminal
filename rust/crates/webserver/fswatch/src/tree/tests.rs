use std::sync::mpsc;
use std::sync::{Arc, Mutex};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::time::{Duration, Instant};

use super::*;

#[cfg(any(target_os = "macos", target_os = "linux"))]
const WAIT: Duration = Duration::from_secs(10);

fn collector() -> (TreeSink, Arc<Mutex<Vec<TreeMsg>>>) {
    let got: Arc<Mutex<Vec<TreeMsg>>> = Arc::default();
    let g = got.clone();
    let sink: TreeSink = Arc::new(move |m| g.lock().unwrap_or_else(|p| p.into_inner()).push(m));
    (sink, got)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn wait_for(got: &Mutex<Vec<TreeMsg>>, pred: impl Fn(&[TreeMsg]) -> bool) -> bool {
    let end = Instant::now() + WAIT;
    while Instant::now() < end {
        if pred(&got.lock().unwrap_or_else(|p| p.into_inner())) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}

#[test]
fn forward_batches_paths_and_lost_wins() {
    let (sink, got) = collector();
    let (tx, rx) = mpsc::channel();
    tx.send(TreeMsg::Paths(vec!["/r/a".into()])).ok();
    tx.send(TreeMsg::Paths(vec!["/r/b".into()])).ok();
    drop(tx);
    forward(&rx, &sink);
    assert_eq!(
        *got.lock().unwrap_or_else(|p| p.into_inner()),
        vec![TreeMsg::Paths(vec!["/r/a".into(), "/r/b".into()])]
    );

    let (sink, got) = collector();
    let (tx, rx) = mpsc::channel();
    tx.send(TreeMsg::Paths(vec!["/r/a".into()])).ok();
    tx.send(TreeMsg::Lost).ok();
    drop(tx);
    forward(&rx, &sink);
    assert_eq!(
        *got.lock().unwrap_or_else(|p| p.into_inner()),
        vec![TreeMsg::Lost]
    );
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn change_deep_in_tree_is_reported_and_drop_stops() {
    let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
    let root = std::fs::canonicalize(dir.path())
        .unwrap_or_else(|e| panic!("{e}"))
        .to_string_lossy()
        .into_owned();
    let deep = format!("{root}/a/b");
    std::fs::create_dir_all(&deep).unwrap_or_else(|e| panic!("{e}"));
    let (sink, got) = collector();
    let w = watch_tree(&root, sink.clone()).unwrap_or_else(|e| panic!("{e}"));
    // FSEvents 는 시작 직후의 쓰기를 놓칠 수 있어 사건이 올 때까지 다시 쓴다.
    let file = format!("{deep}/c.txt");
    let seen = (0..20).any(|i| {
        std::fs::write(&file, format!("{i}")).unwrap_or_else(|e| panic!("{e}"));
        let end = Instant::now() + Duration::from_millis(500);
        while Instant::now() < end {
            let hit =
                got.lock().unwrap_or_else(|p| p.into_inner()).iter().any(
                    |m| matches!(m, TreeMsg::Paths(p) if p.iter().any(|x| x.starts_with(&deep))),
                );
            if hit {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    });
    assert!(
        seen,
        "깊은 경로의 변화를 알리지 않았다: {:?}",
        got.lock().ok()
    );
    drop(w);
    // 감시를 버리면 보내는 쪽이 닫히고 넘기는 스레드가 sink 를 놓는다.
    assert!(
        wait_for(&got, |_| Arc::strong_count(&sink) == 1),
        "감시를 버렸는데 넘기는 스레드가 남았다"
    );
}

#[test]
fn paths_map_back_under_given_root() {
    assert_eq!(
        under_root("/private/tmp/r/a".into(), "/private/tmp/r", "/tmp/r"),
        "/tmp/r/a"
    );
    assert_eq!(
        under_root("/private/tmp/r".into(), "/private/tmp/r", "/tmp/r"),
        "/tmp/r"
    );
    assert_eq!(
        under_root("/private/tmp/rx/a".into(), "/private/tmp/r", "/tmp/r"),
        "/private/tmp/rx/a"
    );
}

/// macOS 의 `/tmp` 는 `/private/tmp` 로 가는 링크다. 감시는 받은 경로 아래로 알린다.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn symlinked_root_reports_under_given_root() {
    let dir = tempfile::tempdir_in("/tmp").unwrap_or_else(|e| panic!("{e}"));
    let root = dir.path().to_string_lossy().into_owned();
    let (sink, got) = collector();
    let _w = watch_tree(&root, sink).unwrap_or_else(|e| panic!("{e}"));
    let file = format!("{root}/x.txt");
    let seen = (0..20).any(|i| {
        std::fs::write(&file, format!("{i}")).unwrap_or_else(|e| panic!("{e}"));
        std::thread::sleep(Duration::from_millis(500));
        got.lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .any(|m| matches!(m, TreeMsg::Paths(p) if p.iter().any(|x| x.starts_with(&root))))
    });
    assert!(
        seen,
        "받은 경로 아래로 알리지 않았다: {:?}",
        got.lock().ok()
    );
}

#[test]
fn network_volume_is_not_watched() {
    let (sink, _) = collector();
    let r = watch_tree("/Volumes/otterminal-no-such-share", sink);
    assert!(r.is_err(), "네트워크 볼륨에 감시를 세웠다");
}
