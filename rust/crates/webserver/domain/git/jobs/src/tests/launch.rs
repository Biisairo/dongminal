//! Go `launch_test.go` — 잡 경로도 동기 실행과 같은 기동 자리를 지난다 (FR-OPT-7-1).

use std::sync::{Arc, Mutex};

use dm_webserver_domain_git_core::Ctx;

use crate::{Emit, LINE_STDOUT, exec_stream_git};

// FR-OPT-7-1 (DOM-18): 실제 저장소에서 공통 기동 자리(core::command)로 git 을 띄운다.
// Go 판의 호출 계수(gittest.Count, PATH 교체)는 옮기지 않았다 — 아래 보고 참고.
#[tokio::test]
async fn exec_stream_git_uses_shared_launch() {
    let Some(repo) = dm_shared_gittest::repo() else {
        return;
    };
    let lines: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let l2 = lines.clone();
    let emit: Emit = Arc::new(move |s, t| l2.lock().unwrap().push((s.into(), t.into())));
    let (exit, err) = exec_stream_git(
        Ctx::background(),
        repo.path().to_string_lossy().into_owned(),
        vec!["log".into(), "-n".into(), "1".into()],
        String::new(),
        emit,
    )
    .await;
    assert!(err.is_none() && exit == 0, "exit={exit} err={err:?}");
    let lines = lines.lock().unwrap();
    assert!(
        lines
            .iter()
            .any(|(s, t)| s == LINE_STDOUT && t.starts_with("commit ")),
        "줄 = {lines:?}"
    );
}
