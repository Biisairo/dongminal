//! Go `stage_test.go`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use otter_webserver_domain_git_core::{self as core, Kind, Output, Service};
use otter_webserver_domain_git_query as query;

use super::support::*;
use crate::*;

#[tokio::test]
async fn stage_unstage_paths_after_separator() {
    let paths = sv(&["-x.txt", "d ir/한글 파일.txt"]);
    let f = WriteFake::default();
    let s = svc_rw(head_runner(), &f);
    stage(&s, &bg(), &abs_tmp_repo(), &paths).await.unwrap();
    unstage(&s, &bg(), &abs_tmp_repo(), &paths).await.unwrap();
    assert_eq!(
        f.argvs(),
        vec![
            sv(&[
                "add",
                "--",
                ":(literal)-x.txt",
                ":(literal)d ir/한글 파일.txt"
            ]),
            sv(&[
                "reset",
                "-q",
                "HEAD",
                "--",
                ":(literal)-x.txt",
                ":(literal)d ir/한글 파일.txt"
            ]),
        ]
    );
}

#[tokio::test]
async fn unstage_no_head_uses_rm_cached() {
    let Some(repo) = temp_repo_no_commit() else {
        return;
    };
    let s = Service::new();
    let ctx = bg();
    unstage(&s, &ctx, repo.p(), &sv(&["a.txt"])).await.unwrap();
    let st = query::status_of(&s, &ctx, repo.p()).await.unwrap();
    assert!(st.staged.is_empty(), "{:?}", st.staged);
    assert!(
        st.untracked.len() == 1 && st.untracked[0].path == "a.txt",
        "{:?}",
        st.untracked
    );
    assert!(repo.join("a.txt").exists(), "워킹 트리의 파일이 사라졌다");
    let mut argv = Vec::new();
    for rec in s.records(0) {
        match rec.argv().first().map(String::as_str) {
            Some("rm") => argv = rec.argv().to_vec(),
            Some("reset") => panic!("HEAD 없는 저장소에 reset 을 실행했다: {:?}", rec.argv()),
            _ => {}
        }
    }
    assert_eq!(argv, sv(&["rm", "--cached", "-q", "--", ":(literal)a.txt"]));
}

#[tokio::test]
async fn stage_paths_rejected() {
    let cases: [(&str, Vec<String>); 6] = [
        ("경로 0개", Vec::new()),
        ("빈 경로", sv(&[""])),
        ("절대경로", sv(&["/etc/passwd"])),
        ("부모 참조", sv(&["a/../../b"])),
        ("정규화 안 됨", sv(&["./a.txt"])),
        ("NUL", sv(&["a\0b"])),
    ];
    for (name, paths) in cases {
        let deny = write_runner(|args, _| panic!("거부돼야 할 호출이 실행됐다: {args:?}"));
        let s = Service::builder()
            .runner(head_runner())
            .write_runner(deny)
            .build();
        let r = abs_tmp_repo();
        let unsafe_arg = |e: Error| e.is_core(Kind::UnsafeArgument);
        assert!(
            unsafe_arg(stage(&s, &bg(), &r, &paths).await.unwrap_err()),
            "{name}: Stage"
        );
        assert!(
            unsafe_arg(unstage(&s, &bg(), &r, &paths).await.unwrap_err()),
            "{name}: Unstage"
        );
        assert!(
            unsafe_arg(discard(&s, &bg(), &r, &paths, &[]).await.unwrap_err()),
            "{name}: Discard(tracked)"
        );
        assert!(
            unsafe_arg(discard(&s, &bg(), &r, &[], &paths).await.unwrap_err()),
            "{name}: Discard(untracked)"
        );
    }
}

#[tokio::test]
async fn stage_splits_and_reports_partial() {
    let paths: Vec<String> = (0..MAX_PATHS_PER_CALL * 2 + 1)
        .map(|i| format!("f{i:04}.txt"))
        .collect();

    let f = WriteFake::default();
    let s = svc_rw(head_runner(), &f);
    stage(&s, &bg(), &abs_tmp_repo(), &paths).await.unwrap();
    let argvs = f.argvs();
    assert_eq!(argvs.len(), 3);
    for (i, want) in [MAX_PATHS_PER_CALL, MAX_PATHS_PER_CALL, 1]
        .into_iter()
        .enumerate()
    {
        assert_eq!(argvs[i].len() - 2, want, "{i} 번째 묶음");
        assert_eq!(argvs[i][1], "--", "{i} 번째 묶음에 `--` 가 없다");
    }

    let calls = Arc::new(AtomicUsize::new(0));
    let c2 = calls.clone();
    let fail = write_runner(move |_, _| {
        if c2.fetch_add(1, Ordering::SeqCst) + 1 == 2 {
            return out("", "index.lock", 1);
        }
        Output::default()
    });
    let s2 = Service::builder()
        .runner(head_runner())
        .write_runner(fail)
        .build();
    let e = stage(&s2, &bg(), &abs_tmp_repo(), &paths)
        .await
        .unwrap_err();
    let be = e.batch().expect("Batch 가 아니다");
    assert!(
        be.partial() && be.applied == MAX_PATHS_PER_CALL && be.total == paths.len(),
        "{be:?}"
    );
    assert_eq!(calls.load(Ordering::SeqCst), 2, "실패 후 중단");
    assert!(e.to_string().contains("index.lock"), "{e}");
}

#[tokio::test]
async fn discard_destructive_and_hint_after_exec() {
    let hints_at_exec = Arc::new(Mutex::new(Vec::new()));
    let argvs = Arc::new(Mutex::new(Vec::new()));
    let cell: Arc<OnceLock<std::sync::Weak<Service>>> = Arc::new(OnceLock::new());
    let (h2, a2, c2) = (hints_at_exec.clone(), argvs.clone(), cell.clone());
    let w = write_runner(move |args, _| {
        let n = c2
            .get()
            .and_then(std::sync::Weak::upgrade)
            .map_or(0, |s| s.hints(0).len());
        h2.lock().unwrap().push(n);
        a2.lock().unwrap().push(args.to_vec());
        Output::default()
    });
    let s = Arc::new(
        Service::builder()
            .runner(head_runner())
            .write_runner(w)
            .build(),
    );
    cell.set(Arc::downgrade(&s)).unwrap();

    discard(
        &s,
        &bg(),
        &abs_tmp_repo(),
        &sv(&["a.txt"]),
        &sv(&["n ew.txt"]),
    )
    .await
    .unwrap();
    assert_eq!(
        *argvs.lock().unwrap(),
        vec![
            sv(&["checkout", "-q", "--", ":(literal)a.txt"]),
            sv(&["clean", "-q", "-f", "--", ":(literal)n ew.txt"]),
        ]
    );
    for (i, n) in hints_at_exec.lock().unwrap().iter().enumerate() {
        assert_eq!(*n, 0, "{i} 번째 실행 시점에 hint 가 이미 있었다");
    }
    let hints = s.hints(0);
    assert_eq!(hints.len(), 1, "{hints:?}");
    let h = &hints[0];
    assert!(
        h.action == core::ACTION_DISCARD && h.repo == abs_tmp_repo() && !h.note.is_empty(),
        "{h:?}"
    );
    assert_eq!(h.targets, Some(sv(&["a.txt", "n ew.txt"])));

    let destructive: Vec<bool> = s
        .records(0)
        .iter()
        .filter(|r| r.argv().first().is_some_and(|a| a != "rev-parse"))
        .map(|r| r.destructive)
        .collect();
    assert_eq!(destructive, vec![true, true]);
}

#[tokio::test]
async fn discard_partial_across_both_commands() {
    let fail = write_runner(|args, _| {
        if args[0] == "clean" {
            return out("", "fatal: clean 실패", 1);
        }
        Output::default()
    });
    let s = Service::builder()
        .runner(head_runner())
        .write_runner(fail)
        .build();
    let e = discard(
        &s,
        &bg(),
        &abs_tmp_repo(),
        &sv(&["a.txt", "b.txt"]),
        &sv(&["n.txt"]),
    )
    .await
    .unwrap_err();
    let be = e.batch().expect("Batch 가 아니다");
    assert!(be.partial() && be.applied == 2 && be.total == 3, "{be:?}");
    assert!(s.hints(0).is_empty(), "{:?}", s.hints(0));
}

#[tokio::test]
async fn discard_failure_leaves_no_hint() {
    let fail = write_runner(|_, _| out("", "fatal: 실패", 1));
    let s = Service::builder()
        .runner(head_runner())
        .write_runner(fail)
        .build();
    assert!(
        discard(&s, &bg(), &abs_tmp_repo(), &sv(&["a.txt"]), &[])
            .await
            .is_err()
    );
    assert!(s.hints(0).is_empty());
}

// DIFF-14: `:` 로 시작하는 경로가 pathspec 매직으로 읽히지 않는다 — 그 이름의 파일만 스테이징된다.
#[tokio::test]
async fn stage_reads_magic_looking_path_literally() {
    let Some(repo) = otter_shared_gittest::repo() else {
        return;
    };
    let dir = repo.path().to_str().unwrap().to_owned();
    std::fs::write(repo.path().join(":(glob)*"), "m\n").unwrap();
    std::fs::write(repo.path().join("other.txt"), "o\n").unwrap();
    let s = Service::new();
    let ctx = bg();
    stage(&s, &ctx, &dir, &sv(&[":(glob)*"])).await.unwrap();
    let st = query::status_of(&s, &ctx, &dir).await.unwrap();
    let staged: Vec<&str> = st.staged.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(staged, vec![":(glob)*"]);
    assert!(st.untracked.iter().any(|e| e.path == "other.txt"));
}
