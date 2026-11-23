//! Go `handlers_git_tag_test.go` 의 이식.
//!
//! 옮기지 않은 Go 테스트: 없다 (8개 전부 옮겼다).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_core::{self as core, Hint, Output, Service};
use dm_webserver_domain_git_jobs::JobRunner;
use dm_webserver_domain_git_store::{Store, StoreOptions};
use serde_json::{Value, json};
use tempfile::TempDir;

use super::harness::{FakeBroker, FakePaneHub, FakeWorkspace, abs, q, qe, req};
use super::wfake::{job_id, wait_done, write_status};
use crate::GitServer;

const TAG_REF_PREFIX: &str = "refs/tags/";

fn repo() -> String {
    abs(&["work", "repo"])
}

fn qrepo() -> String {
    q(&repo())
}

struct TagState {
    status: String,
    tags: HashMap<String, String>,
    writes: Vec<Vec<String>>,
}

/// Go `gitTagFake`: 태그 표면이 딛는 읽기·쓰기를 함께 격리한다.
#[derive(Clone)]
struct TagFake {
    st: Arc<Mutex<TagState>>,
    git_dir: Arc<TempDir>,
}

fn o(stdout: String) -> Output {
    Output {
        stdout: stdout.into_bytes(),
        ..Output::default()
    }
}

/// Go `fakeCheckRefFormatNormalize`: 실측대로 exit 1 + 출력 없음이다.
fn fake_check_ref_format_normalize(full: &str) -> Output {
    if full.contains([' ', '~', '^', ':', '?', '*', '[', '\\'])
        || full.contains("..")
        || full.ends_with(".lock")
    {
        return Output {
            exit_code: 1,
            ..Output::default()
        };
    }
    o(format!("{}\n", full.replace("//", "/")))
}

impl TagFake {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("HEAD"), "ref: refs/heads/main\n").unwrap();
        TagFake {
            st: Arc::new(Mutex::new(TagState {
                status: write_status("a.txt", "M."),
                tags: HashMap::from([("v1.0".to_owned(), "b".repeat(40))]),
                writes: Vec::new(),
            })),
            git_dir: Arc::new(dir),
        }
    }

    fn lock(&self) -> MutexGuard<'_, TagState> {
        self.st.lock().unwrap()
    }

    fn wrote(&self) -> Vec<Vec<String>> {
        self.lock().writes.clone()
    }

    fn read(&self, dir: &str, args: &[String]) -> Output {
        let st = self.lock();
        let a = |i: usize| args.get(i).map(String::as_str).unwrap_or_default();
        match a(0) {
            "rev-parse" if a(1) == "--show-toplevel" => o(format!("{dir}\n")),
            "rev-parse" if args.len() > 2 && a(1) == "--verify" => {
                let name = a(2).strip_prefix(TAG_REF_PREFIX).unwrap_or(a(2));
                match st.tags.get(name) {
                    Some(oid) => o(format!("{oid}\n")),
                    None => Output {
                        exit_code: 128,
                        stderr: "fatal: Needed a single revision\n".to_owned(),
                        ..Output::default()
                    },
                }
            }
            "rev-parse" => o(format!("{0}\n{0}\n", self.git_dir.path().to_string_lossy())),
            "status" => o(st.status.clone()),
            "config" => o("remote.origin.url=/tmp/remote.git\n".to_owned()),
            "check-ref-format" => fake_check_ref_format_normalize(a(2)),
            _ => Output::default(),
        }
    }

    fn service(&self) -> Service {
        let (r, w) = (self.clone(), self.clone());
        Service::builder()
            .runner(Arc::new(move |_, dir: String, args: Vec<String>| {
                let r = r.clone();
                Box::pin(async move { Ok(r.read(&dir, &args)) })
            }))
            .write_runner(Arc::new(move |_, _, args: Vec<String>, _| {
                let w = w.clone();
                Box::pin(async move {
                    w.lock().writes.push(args);
                    Ok(Output::default())
                })
            }))
            .build()
    }
}

type JobArgvs = Arc<Mutex<Vec<Vec<String>>>>;

/// Go `gitTagJobs`: 시작된 작업의 argv 를 모으는 실행기다.
fn tag_jobs(argvs: &JobArgvs) -> JobRunner {
    let argvs = argvs.clone();
    Arc::new(move |_, _, args, _, _| {
        argvs.lock().unwrap().push(args);
        Box::pin(async { (0, None) })
    })
}

/// Go `gitTagServer`. `run` 이 없으면 잡 실행기를 두지 않는다.
fn tag_server(f: &TagFake, run: Option<JobRunner>) -> Arc<GitServer> {
    let at = SystemTime::now();
    let store = Store::new(
        Arc::new(f.service()),
        StoreOptions::default().clock(Arc::new(move || at)),
    );
    Arc::new(GitServer {
        git: Some(store),
        work: Some(Arc::new(FakeWorkspace::default())),
        commands: Some(Arc::new(FakeBroker::default())),
        tools: Some(Arc::new(FakePaneHub::default())),
        job_runner: run,
        ..GitServer::default()
    })
}

fn hints(s: &GitServer) -> Vec<Hint> {
    s.git.as_ref().unwrap().service().hints(0)
}

async fn call(s: &Arc<GitServer>, method: &str, path: &str, body: &str) -> (u16, Value) {
    let r = req(s, method, path, body).await;
    (r.code, r.json())
}

fn argv(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

// C1 (FR-GIT-250): 5개 라우트가 등록돼 있고, Git 이 없으면 전부 503 이다.
#[tokio::test]
async fn git_tag_routes_registered_and_unavailable() {
    let r = qrepo();
    let eps = [
        (
            "POST",
            "/api/git/tag".to_owned(),
            format!(r#"{{"repo":{r},"name":"v9.0"}}"#),
        ),
        (
            "GET",
            format!("/api/git/tag/validate?repo={}&name=v9.0", qe(&repo())),
            String::new(),
        ),
        (
            "POST",
            "/api/git/tag/delete".to_owned(),
            format!(r#"{{"repo":{r},"name":"v1.0","confirm":true}}"#),
        ),
        (
            "POST",
            "/api/git/tag/push".to_owned(),
            format!(r#"{{"repo":{r},"name":"v1.0"}}"#),
        ),
        (
            "POST",
            "/api/git/tag/delete-remote".to_owned(),
            format!(r#"{{"repo":{r},"name":"v1.0","confirm":true}}"#),
        ),
    ];
    let s = Arc::new(GitServer {
        tools: Some(Arc::new(FakePaneHub::default())),
        work: Some(Arc::new(FakeWorkspace::default())),
        ..GitServer::default()
    });
    for (method, path, body) in &eps {
        let p = path.split('?').next().unwrap();
        assert!(
            dm_webserver_httproute::dispatch(&crate::routes::ROUTES, method, p).is_some(),
            "{method} {p} 가 gitapi.routes 에 없다"
        );
        let (code, out) = call(&s, method, path, body).await;
        assert_eq!(
            (code, out["error"].as_str()),
            (503, Some(apierr::CODE_UNAVAILABLE)),
            "{method} {path}"
        );
    }
}

// C2 (V189, FR-GIT-89·250.1): confirm 없는 파괴적 요청은 실행되지 않는다 — 로컬·원격 둘 다.
#[tokio::test]
async fn api_git_tag_delete_requires_confirm() {
    let job_argvs: JobArgvs = Arc::default();
    let cases = [
        ("로컬 삭제", "/api/git/tag/delete"),
        ("원격 삭제", "/api/git/tag/delete-remote"),
    ];
    for (name, path) in cases {
        let f = TagFake::new();
        let s = tag_server(&f, Some(tag_jobs(&job_argvs)));
        let (code, out) = call(
            &s,
            "POST",
            path,
            &format!(r#"{{"repo":{},"name":"v1.0"}}"#, qrepo()),
        )
        .await;
        assert_eq!(
            (code, out["error"].as_str()),
            (400, Some(apierr::CODE_CONFIRM_REQUIRED)),
            "{name}: {out}"
        );
        assert!(
            f.wrote().is_empty(),
            "{name}: 거부됐는데 쓰기가 실행됐다: {:?}",
            f.wrote()
        );
        assert!(
            job_argvs.lock().unwrap().is_empty(),
            "{name}: 거부됐는데 작업이 떴다"
        );
        // hint 도 남지 않는다 — 지우지 않은 것의 복구 안내는 거짓이다.
        assert!(hints(&s).is_empty(), "{name}: 거부됐는데 hint 가 남았다");
    }
}

// C3 (V189, FR-GIT-261): confirm 이 있으면 로컬 삭제가 `tag -d` 하나만 실행한다.
#[tokio::test]
async fn api_git_tag_delete_local_only() {
    let f = TagFake::new();
    let job_argvs: JobArgvs = Arc::default();
    let s = tag_server(&f, Some(tag_jobs(&job_argvs)));
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/tag/delete",
        &format!(r#"{{"repo":{},"name":"v1.0","confirm":true}}"#, qrepo()),
    )
    .await;
    assert_eq!((code, &out["ok"]), (200, &json!(true)), "{out}");
    assert_eq!(f.wrote(), vec![argv(&["tag", "-d", "v1.0"])]);
    assert!(
        job_argvs.lock().unwrap().is_empty(),
        "로컬 삭제가 원격 작업을 함께 띄웠다"
    );
    // recovery hint 가 지우기 전 oid 를 싣는다 (FR-GIT-92·250.2).
    let h = hints(&s);
    assert_eq!(h.len(), 1, "hint = {h:?}");
    assert_eq!(h[0].action, core::ACTION_TAG_DELETE);
    assert!(
        h[0].command.contains(&"b".repeat(40)),
        "hint 명령에 지우기 전 oid 가 없다: {:?}",
        h[0].command
    );
}

// C4 (V189, FR-GIT-261): 원격 삭제는 job 경로로 `push --delete` 를 실행하고 로컬은 건드리지 않는다.
#[tokio::test]
async fn api_git_tag_delete_remote_job_path_only() {
    let f = TagFake::new();
    let job_argvs: JobArgvs = Arc::default();
    let s = tag_server(&f, Some(tag_jobs(&job_argvs)));
    let (code, out) = call(
        &s,
        "POST",
        "/api/git/tag/delete-remote",
        &format!(r#"{{"repo":{},"name":"v1.0","confirm":true}}"#, qrepo()),
    )
    .await;
    assert_eq!(code, 200, "{out}");
    let id = job_id(&out);
    assert_eq!(out["remote"], "origin", "{out}");
    let jb = wait_done(&s, &id).await;
    assert_eq!(
        jb.argv,
        argv(&["push", "--progress", "origin", "--delete", "refs/tags/v1.0"])
    );
    assert!(
        f.wrote().is_empty(),
        "원격 삭제가 로컬 쓰기 경로로 흘렀다: {:?}",
        f.wrote()
    );
    let h = hints(&s);
    assert_eq!(h.len(), 1, "hint = {h:?}");
    assert_eq!(h[0].action, core::ACTION_REMOTE_REF_DELETE);
}

// C5 (V190, FR-GIT-262): 태그 push 는 job 경로다. 하나와 전부(`--tags`)가 다른 argv 로 간다.
#[tokio::test]
async fn api_git_tag_push_job_path() {
    let cases = [
        (
            "태그 하나",
            format!(r#"{{"repo":{},"name":"v1.0"}}"#, qrepo()),
            argv(&["push", "--progress", "origin", "refs/tags/v1.0"]),
        ),
        (
            "전부",
            format!(r#"{{"repo":{},"all":true}}"#, qrepo()),
            argv(&["push", "--progress", "origin", "--tags"]),
        ),
    ];
    for (name, body, want) in cases {
        let f = TagFake::new();
        let job_argvs: JobArgvs = Arc::default();
        let s = tag_server(&f, Some(tag_jobs(&job_argvs)));
        let (code, out) = call(&s, "POST", "/api/git/tag/push", &body).await;
        assert_eq!(code, 200, "{name}: {out}");
        let jb = wait_done(&s, &job_id(&out)).await;
        assert_eq!(jb.argv, want, "{name}");
        // push 는 파괴적이 아니므로 hint 를 남기지 않는다.
        assert!(hints(&s).is_empty(), "{name}: push 가 hint 를 남겼다");
    }
}

// C6 (V188, FR-GIT-260·250.3): 이름 규칙 위반과 중복은 실행 전에 거부된다.
#[tokio::test]
async fn api_git_tag_create_rejects_before_executing() {
    let r = qrepo();
    let cases = [
        (
            "이름 규칙 위반",
            format!(r#"{{"repo":{r},"name":"bad name"}}"#),
            400,
            apierr::CODE_REF_NAME,
        ),
        (
            "- 로 시작하는 이름",
            format!(r#"{{"repo":{r},"name":"-x"}}"#),
            400,
            apierr::CODE_REF_NAME,
        ),
        (
            "이미 있는 이름",
            format!(r#"{{"repo":{r},"name":"v1.0"}}"#),
            409,
            apierr::CODE_TAG_EXISTS,
        ),
        (
            "모르는 종류",
            format!(r#"{{"repo":{r},"name":"v9.0","kind":"gpg"}}"#),
            400,
            apierr::CODE_TAG_KIND_INVALID,
        ),
        (
            "annotated 인데 메시지 없음",
            format!(r#"{{"repo":{r},"name":"v9.0","kind":"annotated"}}"#),
            400,
            apierr::CODE_TAG_MESSAGE_REQUIRED,
        ),
    ];
    for (name, body, want_code, want_err) in cases {
        let f = TagFake::new();
        let s = tag_server(&f, None);
        let (code, out) = call(&s, "POST", "/api/git/tag", &body).await;
        assert_eq!(
            (code, out["error"].as_str()),
            (want_code, Some(want_err)),
            "{name}: {out}"
        );
        assert!(
            f.wrote().is_empty(),
            "{name}: 거부됐는데 실행됐다: {:?}",
            f.wrote()
        );
    }
}

// C7 (V187, FR-GIT-260): 종류마다 argv 가 다르고 메시지는 annotated·signed 에만 붙는다.
#[tokio::test]
async fn api_git_tag_create_kind_argv() {
    let r = qrepo();
    let cases = [
        (
            "lightweight",
            format!(r#"{{"repo":{r},"name":"v9.0","message":"뜻이 없다"}}"#),
            argv(&["tag", "v9.0"]),
        ),
        (
            "annotated",
            format!(r#"{{"repo":{r},"name":"v9.0","kind":"annotated","message":"릴리스"}}"#),
            argv(&["tag", "-a", "-m", "릴리스", "v9.0"]),
        ),
        (
            "signed + 대상",
            format!(
                r#"{{"repo":{r},"name":"v9.0","kind":"signed","message":"서명","ref":"abc123"}}"#
            ),
            argv(&["tag", "-s", "-m", "서명", "v9.0", "abc123"]),
        ),
    ];
    for (name, body, want) in cases {
        let f = TagFake::new();
        let s = tag_server(&f, None);
        let (code, out) = call(&s, "POST", "/api/git/tag", &body).await;
        assert_eq!((code, &out["ok"]), (200, &json!(true)), "{name}: {out}");
        assert_eq!(f.wrote(), vec![want], "{name}");
    }
}

// C8 (V188, FR-GIT-260): 이름 검사는 200 의 본문으로 판정을 준다. `exists` 는 따로 온다.
#[tokio::test]
async fn api_git_tag_validate_judges_in_body() {
    let f = TagFake::new();
    let s = tag_server(&f, None);
    let cases = [
        ("쓸 수 있는 이름", "v9.0", true, false),
        ("이미 있는 이름", "v1.0", true, true),
        ("규칙 위반", "bad name", false, false),
    ];
    for (name, qn, ok, exists) in cases {
        let (code, out) = call(
            &s,
            "GET",
            &format!(
                "/api/git/tag/validate?repo={}&name={}",
                qe(&repo()),
                qn.replace(' ', "%20")
            ),
            "",
        )
        .await;
        assert_eq!(code, 200, "{name}: {out}");
        assert_eq!(
            (&out["ok"], &out["exists"]),
            (&json!(ok), &json!(exists)),
            "{name}: {out}"
        );
        if !ok {
            assert!(
                !out["reason"].as_str().unwrap_or_default().is_empty(),
                "{name}: 위반인데 사유가 없다: {out}"
            );
        }
    }
}
