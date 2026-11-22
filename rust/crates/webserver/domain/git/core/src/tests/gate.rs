//! 정적 게이트 (FR-GIT-1·95, FR-GXU-11·12, FR-GIT-104). Go 판은 Go 소스를, Rust 판은
//! `rust/crates/**/*.rs` 를 훑는다. 패턴은 조각으로 조립한다 — 이 파일이 자기를 잡지 않게.

use std::path::{Path, PathBuf};

use regex::Regex;

fn crates_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

/// crates 아래 모든 .rs 를 (crates 기준 상대경로, 본문)으로 훑는다.
fn rs_files() -> Vec<(String, String)> {
    fn walk(dir: &Path, root: &Path, out: &mut Vec<(String, String)>) {
        let Ok(rd) = std::fs::read_dir(dir) else {
            return;
        };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if e.file_name() != "target" {
                    walk(&p, root, out);
                }
            } else if p.extension().is_some_and(|x| x == "rs") {
                let rel = p
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, std::fs::read_to_string(&p).unwrap_or_default()));
            }
        }
    }
    let root = crates_root().canonicalize().unwrap();
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out
}

const GIT_DOMAIN: &str = "webserver/domain/git/";
const TEST_ONLY_GIT: &str = "shared/gittest/";

fn is_test_file(rel: &str) -> bool {
    rel.contains("/tests/") || rel.ends_with("/tests.rs")
}

fn offenders(re: &Regex, allowed: impl Fn(&str) -> bool) -> Vec<String> {
    let mut v = Vec::new();
    for (rel, body) in rs_files() {
        if allowed(&rel) {
            continue;
        }
        for (i, line) in body.lines().enumerate() {
            if re.is_match(line) {
                v.push(format!("{rel}:{}: {}", i + 1, line.trim()));
            }
        }
    }
    v
}

fn git_lit() -> String {
    format!("\"{}\"", "gi".to_owned() + "t")
}

fn direct_exec() -> Regex {
    Regex::new(&format!(r"Command::{}\({}\)", "new", git_lit())).unwrap()
}

fn git_lookup() -> Regex {
    Regex::new(&format!(r"look_path(_in)?\({}", git_lit())).unwrap()
}

fn unguarded_call() -> Regex {
    Regex::new(&format!(
        r"\b({}|{}|{})\(",
        "exec_unguarded", "exec_unguarded_text", "unguarded_text_runner"
    ))
    .unwrap()
}

fn exec_write_call() -> Regex {
    Regex::new(&format!(r"\.{}\(", "exec_write")).unwrap()
}

#[test]
fn scan_sees_files() {
    // 하한은 Rust 기준이다 — 훑은 수가 적으면 통과가 무의미하다.
    assert!(rs_files().len() >= 20);
}

// V1 (FR-GIT-1): git 을 직접 실행하는 곳은 git 도메인과 시험 전용 gittest 뿐이다.
#[test]
fn no_direct_git_exec_outside_domain() {
    let v = offenders(&direct_exec(), |r| {
        r.starts_with(GIT_DOMAIN) || r.starts_with(TEST_ONLY_GIT)
    });
    assert!(v.is_empty(), "{v:#?}");
}

// V16 (FR-GXU-11): git 바이너리를 얻는 자리가 git 도메인 밖에 없다.
#[test]
fn git_lookup_confined_to_domain() {
    let v = offenders(&git_lookup(), |r| {
        r.starts_with(GIT_DOMAIN) || r.starts_with(TEST_ONLY_GIT) || is_test_file(r)
    });
    assert!(v.is_empty(), "{v:#?}");
}

// FR-GXU-12: 인가를 건너뛰는 진입점의 호출처.
#[test]
fn unguarded_callers_restricted() {
    let v = offenders(&unguarded_call(), |r| {
        r.starts_with(GIT_DOMAIN)
            || r.starts_with("webserver/domain/worktree/")
            || r.starts_with("webserver/domain/submodule/")
            || r.starts_with("webserver/httpapi/src/handlers_fs_ignored")
    });
    assert!(v.is_empty(), "{v:#?}");
}

// W3 (FR-GIT-95): exec_write 를 부르는 곳은 git 도메인과 gitapi 뿐이다.
#[test]
fn exec_write_callers_restricted() {
    let v = offenders(&exec_write_call(), |r| {
        r.starts_with(GIT_DOMAIN) || r.starts_with("webserver/gitapi/")
    });
    assert!(v.is_empty(), "{v:#?}");
}

#[test]
fn patterns_discriminate() {
    let g = git_lit();
    assert!(direct_exec().is_match(&format!("let c = Command::new({g});")));
    assert!(!direct_exec().is_match("let c = Command::new(bin);"));
    assert!(!direct_exec().is_match("Command::new(\"gitk\")"));
    assert!(git_lookup().is_match(&format!("look_path({g})")));
    assert!(git_lookup().is_match(&format!("look_path_in({g}, p)")));
    for s in [
        "svc.exec_unguarded(&ctx",
        "core::exec_unguarded_text(None",
        "unguarded_text_runner(svc",
    ] {
        assert!(unguarded_call().is_match(s), "{s}");
    }
    assert!(exec_write_call().is_match("s.exec_write(&ctx, root, &spec)"));
    assert!(!exec_write_call().is_match("exec_write_something(ctx)"));
}

// FR-GIT-104: git 표면에 자격증명 낱말이 없다. 원격 파일에는 token·secret 도 없다.
#[test]
fn no_credential_words_in_git_surface() {
    let words = Regex::new(&format!(
        "(?i){}|{}|{}|{}",
        "pass".to_owned() + "word",
        "pass".to_owned() + "wd",
        "pass".to_owned() + "phrase",
        "creden".to_owned() + "tial"
    ))
    .unwrap();
    let remote = Regex::new(&format!(
        "(?i){}|{}",
        "to".to_owned() + "ken",
        "sec".to_owned() + "ret"
    ))
    .unwrap();
    let dirs = [
        "webserver/domain/git/core/src/",
        "webserver/domain/git/query/src/",
        "webserver/domain/git/write/src/",
        "webserver/domain/git/store/src/",
        "webserver/domain/git/jobs/src/",
        "webserver/gitapi/src/",
        "webserver/httpapi/src/",
    ];
    let mut v = Vec::new();
    for (rel, body) in rs_files() {
        if !dirs.iter().any(|d| rel.starts_with(d)) || is_test_file(&rel) {
            continue;
        }
        let remote_file = rel.ends_with("/remote.rs") || rel.ends_with("/job.rs");
        for (i, line) in body.lines().enumerate() {
            if words.is_match(line) || (remote_file && remote.is_match(line)) {
                v.push(format!("{rel}:{}", i + 1));
            }
        }
    }
    assert!(v.is_empty(), "{v:#?}");
}
