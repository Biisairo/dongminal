use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::support::*;
use crate::preflight::*;
use crate::*;
use otter_webserver_domain_git_core::Service;

fn touch(dir: &str, rel: &str) {
    write_file(dir, rel, "");
}

fn mkdir(dir: &str, rel: &str) {
    std::fs::create_dir_all(format!("{dir}/{rel}")).unwrap();
}

#[test]
fn detect_operation_by_marker() {
    let cases: [(&str, fn(&str)); 6] = [
        (OP_NONE, |_| {}),
        (OP_MERGE, |d| touch(d, MERGE_HEAD_FILE)),
        (OP_REBASE, |d| mkdir(d, REBASE_MERGE_DIR)),
        (OP_REBASE, |d| mkdir(d, REBASE_APPLY_DIR)),
        (OP_CHERRY_PICK, |d| touch(d, CHERRY_PICK_HEAD_FILE)),
        (OP_REVERT, |d| touch(d, REVERT_HEAD_FILE)),
    ];
    for (want, setup) in cases {
        let d = temp_dir();
        setup(&d.path);
        assert_eq!(detect_operation(&d.path).kind, want);
    }
    let d = temp_dir();
    mkdir(&d.path, REBASE_MERGE_DIR);
    touch(&d.path, CHERRY_PICK_HEAD_FILE);
    let op = detect_operation(&d.path);
    assert!(op.kind == OP_REBASE && op.at == 0 && op.total == 0 && op.in_progress());
    assert!(!Operation::default().in_progress());
}

#[test]
fn detect_operation_progress() {
    for (dir, at, end, want) in [
        (REBASE_MERGE_DIR, "msgnum", "end", (2, 5)),
        (REBASE_APPLY_DIR, "next", "last", (3, 7)),
    ] {
        let d = temp_dir();
        write_file(&d.path, &format!("{dir}/{at}"), &format!("{}\n", want.0));
        write_file(&d.path, &format!("{dir}/{end}"), &format!("{}\n", want.1));
        let op = detect_operation(&d.path);
        assert_eq!(
            (op.kind.as_str(), op.at, op.total),
            (OP_REBASE, want.0, want.1)
        );
        assert_eq!(
            json(&op),
            format!(
                "{{\"kind\":\"rebase\",\"at\":{},\"total\":{}}}",
                want.0, want.1
            )
        );
    }
    let d = temp_dir();
    write_file(
        &d.path,
        &format!("{REBASE_APPLY_DIR}/{REBASE_APPLYING}"),
        "1\n",
    );
    write_file(&d.path, &format!("{REBASE_APPLY_DIR}/next"), "2\n");
    write_file(&d.path, &format!("{REBASE_APPLY_DIR}/last"), "5\n");
    let op = detect_operation(&d.path);
    assert_eq!((op.kind.as_str(), op.at, op.total), (OP_AM, 2, 5));
    let d = temp_dir();
    write_file(&d.path, BISECT_LOG_FILE, "git bisect start\n");
    assert_eq!(detect_operation(&d.path).kind, OP_BISECT);
    write_file(&d.path, MERGE_HEAD_FILE, "deadbeef\n");
    assert_eq!(detect_operation(&d.path).kind, OP_MERGE);
}

#[test]
fn operation_markers_cover_preflight_checks() {
    for kind in [
        OP_MERGE,
        OP_REBASE,
        OP_CHERRY_PICK,
        OP_REVERT,
        OP_AM,
        OP_BISECT,
    ] {
        let d = temp_dir();
        let names = crate::operation::markers_of(kind);
        assert!(!names.is_empty());
        for n in &names {
            touch(&d.path, n);
        }
        assert_eq!(detect_operation(&d.path).kind, kind);
    }
}

struct PfFake {
    git_dir: Temp,
    config: Arc<Mutex<HashMap<String, String>>>,
}

impl PfFake {
    fn new() -> Self {
        let git_dir = temp_dir();
        write_file(&git_dir.path, "HEAD", "ref: refs/heads/main\n");
        let config = HashMap::from([
            ("user.name".into(), "tester".into()),
            ("user.email".into(), "t@example.com".into()),
        ]);
        PfFake {
            git_dir,
            config: Arc::new(Mutex::new(config)),
        }
    }

    fn set(&self, k: &str, v: Option<&str>) {
        let mut c = self.config.lock().unwrap();
        match v {
            Some(v) => c.insert(k.into(), v.into()),
            None => c.remove(k),
        };
    }

    async fn run(&self) -> Preflight {
        let gd = self.git_dir.path.clone();
        let cfg = self.config.clone();
        let s = fake_by(move |a| match a[0].as_str() {
            "rev-parse" => out(&format!("{gd}\n{gd}\n"), "", 0),
            "config" => {
                let body: String = cfg
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|(k, v)| format!("{k}\n{v}\0"))
                    .collect();
                out(&body, "", 0)
            }
            _ => out("", "", 0),
        });
        preflight_of(&s, &bg(), &abs_repo()).await.unwrap()
    }
}

fn codes(pf: &Preflight) -> Vec<&str> {
    pf.blocks.iter().map(|b| b.code.as_str()).collect()
}

#[tokio::test]
async fn preflight_blocks() {
    let f = PfFake::new();
    let pf = f.run().await;
    assert!(pf.blocks.is_empty() && pf.warnings.is_empty());
    assert_eq!(
        json(&pf),
        r#"{"blocks":[],"warnings":[],"gpgSign":false,"template":""}"#
    );
    for (setup, want) in [
        (
            Box::new(|f: &PfFake| f.set("user.name", None)) as Box<dyn Fn(&PfFake)>,
            BLOCK_IDENTITY_MISSING,
        ),
        (
            Box::new(|f: &PfFake| f.set("user.email", None)),
            BLOCK_IDENTITY_MISSING,
        ),
        (
            Box::new(|f: &PfFake| f.set("user.name", Some(""))),
            BLOCK_IDENTITY_MISSING,
        ),
        (
            Box::new(|f: &PfFake| touch(&f.git_dir.path, MERGE_HEAD_FILE)),
            BLOCK_MERGE_IN_PROGRESS,
        ),
        (
            Box::new(|f: &PfFake| mkdir(&f.git_dir.path, REBASE_MERGE_DIR)),
            BLOCK_REBASE_IN_PROGRESS,
        ),
        (
            Box::new(|f: &PfFake| mkdir(&f.git_dir.path, REBASE_APPLY_DIR)),
            BLOCK_REBASE_IN_PROGRESS,
        ),
        (
            Box::new(|f: &PfFake| touch(&f.git_dir.path, CHERRY_PICK_HEAD_FILE)),
            BLOCK_CHERRY_PICK_IN_PROGRESS,
        ),
        (
            Box::new(|f: &PfFake| touch(&f.git_dir.path, REVERT_HEAD_FILE)),
            BLOCK_REVERT_IN_PROGRESS,
        ),
    ] {
        let f = PfFake::new();
        setup(&f);
        assert!(codes(&f.run().await).contains(&want), "{want}");
    }
    let f = PfFake::new();
    f.set("user.name", None);
    f.set("user.email", None);
    let b = &f.run().await.blocks[0];
    assert_eq!(
        b.reason,
        "user.name · user.email 이 설정되지 않아 커밋의 작성자를 정할 수 없습니다"
    );
    assert_eq!(
        b.fix,
        "git config --global user.name \"…\" && git config --global user.email \"…\""
    );
}

#[tokio::test]
async fn preflight_every_block_has_reason_and_fix() {
    let f = PfFake::new();
    f.set("user.name", None);
    touch(&f.git_dir.path, MERGE_HEAD_FILE);
    mkdir(&f.git_dir.path, REBASE_MERGE_DIR);
    touch(&f.git_dir.path, CHERRY_PICK_HEAD_FILE);
    touch(&f.git_dir.path, REVERT_HEAD_FILE);
    let pf = f.run().await;
    assert_eq!(
        codes(&pf),
        [
            BLOCK_IDENTITY_MISSING,
            BLOCK_MERGE_IN_PROGRESS,
            BLOCK_REBASE_IN_PROGRESS,
            BLOCK_CHERRY_PICK_IN_PROGRESS,
            BLOCK_REVERT_IN_PROGRESS
        ]
    );
    assert!(
        pf.blocks
            .iter()
            .all(|b| !b.reason.trim().is_empty() && !b.fix.trim().is_empty())
    );
}

#[tokio::test]
async fn preflight_detached_template_gpg() {
    let f = PfFake::new();
    write_file(&f.git_dir.path, "HEAD", &format!("{}\n", "1".repeat(40)));
    let pf = f.run().await;
    assert!(
        pf.blocks.is_empty() && pf.warnings.len() == 1 && pf.warnings[0].code == WARN_DETACHED_HEAD
    );
    assert!(pf.warnings[0].reason.contains("브랜치"));

    let t = temp_dir();
    let body = "# 제목\n\n# 본문\n";
    write_file(&t.path, "gitmessage", body);
    let f = PfFake::new();
    f.set("commit.template", Some(&format!("{}/gitmessage", t.path)));
    f.set("commit.gpgsign", Some("true"));
    let pf = f.run().await;
    assert!(pf.template == body && pf.gpg_sign);
    let f = PfFake::new();
    f.set("commit.template", Some(&format!("{}/없는파일", t.path)));
    f.set("commit.gpgsign", Some("false"));
    let pf = f.run().await;
    assert!(pf.template.is_empty() && !pf.gpg_sign);
    let pf = PfFake::new().run().await;
    assert!(pf.template.is_empty() && !pf.gpg_sign);
}

#[tokio::test]
async fn preflight_real_git() {
    let Some(repo) = git_repo() else { return };
    let p = repo.path.as_str();
    let s = Service::new();
    let pf = preflight_of(&s, &bg(), p).await.unwrap();
    assert!(pf.blocks.is_empty() && pf.warnings.is_empty(), "{pf:?}");
    git_run(p, &["config", "--unset", "user.name"]);
    let pf = preflight_of(&s, &bg(), p).await.unwrap();
    // 전역 설정에 이름이 있으면 차단되지 않는다 — hermetic HOME 이 그것을 막는다.
    if codes(&pf).is_empty() {
        return;
    }
    assert!(codes(&pf).contains(&BLOCK_IDENTITY_MISSING));
    git_run(p, &["checkout", "-q", "--detach"]);
    let pf = preflight_of(&s, &bg(), p).await.unwrap();
    assert!(pf.warnings.len() == 1 && pf.warnings[0].code == WARN_DETACHED_HEAD);
}
