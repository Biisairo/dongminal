//! 5.5.2 종단의 Go 골든 대조. 기대값은 go1.27.2 기준선의 핸들러를 임시 시험으로 돌려 뽑았다.

use super::fakes::*;
use super::support::*;
use crate::{Deps, Server};
use http_body_util::BodyExt;
use otter_shared_sandbox::{
    self as sandbox, DevConfig, Mount, RUNTIME_MISSING, RUNTIME_STOPPED, RuntimeStatus,
};
use otter_webserver_domain_sysstat::Snapshot;
use otter_webserver_hub::{CommandBroker, CommandHub};
use std::sync::Arc;

/// (서버, 메서드, 경로, 본문, 머리).
type Case<'a> = (
    &'a Arc<Server>,
    &'a str,
    &'a str,
    &'a str,
    Vec<(&'a str, &'a str)>,
);

fn canon(k: &str) -> String {
    k.split('-')
        .map(|p| {
            let mut c = p.chars();
            match c.next() {
                Some(f) => f.to_ascii_uppercase().to_string() + &c.as_str().to_ascii_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}
fn q(s: &str) -> String {
    otter_gocompat::strconv::quote(s)
}
fn dump(m: &str, p: &str, r: &Resp) -> String {
    let mut hs: Vec<String> = r
        .headers
        .iter()
        .filter(|(k, _)| k.as_str() != "x-request-id")
        .map(|(k, v)| format!("{}={}", canon(k.as_str()), v.to_str().unwrap()))
        .collect();
    hs.sort();
    format!(
        "== {m} {p}\n{} {}\n{}\n",
        r.status,
        hs.join("|"),
        q(&r.body)
    )
}

/// Go 기준선의 실제 핸들러가 같은 요청에 낸 출력과 바이트 단위로 대조한다 (호스트 이름만 가린다).
#[tokio::test]
async fn golden_552() {
    let ph = Arc::new(FakeHub::default());
    ph.seed("1", "Shell #1");
    ph.busy.lock().unwrap().insert("b".into(), true);
    let fw = Arc::new(FakeWork {
        coord_map: [("u-1".to_owned(), "W2.P1.T1".to_owned())].into(),
        ..FakeWork::with(r#"{"windows":[],"activeWindow":"w1","schemaVersion":2}"#, 3)
    });
    let st = Arc::new(FakeSettings::default());
    *st.blob.lock().unwrap() = br#"{"fgTabNames":false}"#.to_vec();
    let cmd: Arc<dyn CommandBroker> = CommandHub::new();
    let sub = cmd.add().unwrap();
    let mut cfg = sandbox::Config::default();
    cfg.mounts = vec![Mount {
        host: "/h".into(),
        container: "/c".into(),
        read_only: true,
        scratch: false,
    }];
    cfg.dev = Some(DevConfig {
        image: "node:22".into(),
        ports: vec![],
    });
    let reaper = Arc::new(FakeReaper {
        cfg: Some(cfg),
        profiles: vec![sandbox::scratch().info()],
        ..FakeReaper::default()
    });
    let stats = Arc::new(FakeStats {
        snap: Snapshot {
            cpu: 27.7,
            cpu_valid: true,
            mem_total: 34359738368,
            mem_used: 6624083968,
            mem_valid: true,
            mem_total_valid: true,
            disk_pct: 42.1,
            disk_valid: true,
            boot_time: None,
        },
        ..FakeStats::default()
    });
    let d1 = tempfile::tempdir().unwrap();
    let d2 = tempfile::tempdir().unwrap();
    let srv = server(
        d1.path(),
        Deps {
            tools: Some(ph),
            work: Some(fw),
            settings: Some(st),
            commands: Some(cmd),
            sandbox: Some(reaper),
            stats: Some(stats),
            ..Deps::default()
        },
    );
    let nosrv = server(d2.path(), Deps::default());
    let j: &[(&str, &str)] = &[("Content-Type", "application/json")];
    let ids = "x,".repeat(257);
    let long = format!(
        r#"{{"action":"renameTab","args":{{"location":"u-1","name":"{}"}}}}"#,
        "x".repeat(65)
    );
    let busy_ids = format!("/api/tools/busy?ids={ids}");
    let reqs: Vec<Case<'_>> = vec![
        (&srv, "GET", "/api/state", "", vec![]),
        (&nosrv, "GET", "/api/state", "", vec![]),
        (&srv, "POST", "/api/tools?cols=80&rows=24", "", j.to_vec()),
        (&srv, "POST", "/api/tools?cwd=/no/such/dir", "", j.to_vec()),
        (&nosrv, "POST", "/api/tools", "", j.to_vec()),
        (&srv, "GET", "/api/tools/b/busy", "", vec![]),
        (&srv, "GET", "/api/tools/busy?ids=b,,a", "", vec![]),
        (&srv, "GET", &busy_ids, "", vec![]),
        (&srv, "GET", "/api/tools/busy", "", vec![]),
        (&srv, "DELETE", "/api/tools/zz", "", j.to_vec()),
        (&srv, "POST", "/api/tools/kill", "", j.to_vec()),
        (
            &srv,
            "POST",
            "/api/tools/kill",
            r#"{"toolId":""}"#,
            j.to_vec(),
        ),
        (
            &srv,
            "POST",
            "/api/tools/kill",
            r#"{"toolId":"nope"}"#,
            j.to_vec(),
        ),
        (
            &srv,
            "POST",
            "/api/tools/kill",
            r#"{"toolId":1}"#,
            j.to_vec(),
        ),
        (&srv, "GET", "/api/workspace", "", vec![]),
        (&nosrv, "GET", "/api/workspace", "", vec![]),
        (&nosrv, "PUT", "/api/workspace", "{}", j.to_vec()),
        (
            &srv,
            "PUT",
            "/api/workspace",
            r#"{"schemaVersion":2,"windows":[]}"#,
            j.to_vec(),
        ),
        (
            &srv,
            "PUT",
            "/api/workspace",
            r#"{"schemaVersion":2,"windows":[]}"#,
            vec![("Content-Type", "application/json"), ("If-Match", "99")],
        ),
        (
            &srv,
            "PUT",
            "/api/workspace",
            r#"{"schemaVersion":2,"windows":[]}"#,
            vec![("Content-Type", "application/json"), ("If-Match", "3")],
        ),
        (&srv, "GET", "/api/sandbox/profiles", "", vec![]),
        (&nosrv, "GET", "/api/sandbox/profiles", "", vec![]),
        (&nosrv, "GET", "/api/sandbox/config", "", vec![]),
        (&srv, "GET", "/api/sandbox/config", "", vec![]),
        (
            &srv,
            "PUT",
            "/api/sandbox/config",
            "{}",
            vec![("Content-Type", "application/json"), ("If-Match", "nope")],
        ),
        (
            &srv,
            "PUT",
            "/api/sandbox/config",
            r#"{"dev":{"image":"x"}}"#,
            j.to_vec(),
        ),
        (&nosrv, "GET", "/api/stats?jobs=1", "", vec![]),
        (&srv, "GET", "/api/stats", "", vec![]),
        (&srv, "GET", "/api/commands", "", vec![]),
        (&srv, "POST", "/api/commands", "{bad", j.to_vec()),
        (
            &srv,
            "POST",
            "/api/commands",
            r#"{"action":"hack"}"#,
            j.to_vec(),
        ),
        (&srv, "POST", "/api/commands", "{}", j.to_vec()),
        (
            &srv,
            "POST",
            "/api/commands",
            r#"{"action":"tabNext"}"#,
            j.to_vec(),
        ),
        (
            &srv,
            "POST",
            "/api/commands",
            r#"{"action":"focus","args":{"location":"u-1","big":12345678901234567890,"f":1.50,"e":1e3,"neg":-0,"z":{"b":1,"a":[1.0,2e-7]}}}"#,
            j.to_vec(),
        ),
        (
            &srv,
            "POST",
            "/api/commands",
            r#"{"action":"focus","args":{"location":"W2.P1.T1"}}"#,
            j.to_vec(),
        ),
        (&srv, "POST", "/api/commands", &long, j.to_vec()),
        (
            &srv,
            "POST",
            "/api/commands",
            r#"{"action":"openUrl","args":{"url":"ftp://x"}}"#,
            j.to_vec(),
        ),
        (
            &srv,
            "POST",
            "/api/commands",
            r#"{"action":"openUrl","args":{"url":"https://x.dev"}}"#,
            j.to_vec(),
        ),
        (&srv, "GET", "/api/open-url/where", "", vec![]),
        (&srv, "POST", "/api/open-url/where", "", j.to_vec()),
        (&srv, "GET", "/api/focus", "", vec![]),
        (&srv, "POST", "/api/focus/claim", "{}", j.to_vec()),
    ];
    let mut out = String::new();
    for (s, m, p, body, h) in reqs {
        let r = call(s, m, p, &h, body, "127.0.0.1:5000").await;
        out.push_str(&dump(m, p, &r));
        while let Some(b) = sub.try_recv() {
            out.push_str(&format!("SSE {}\n", String::from_utf8_lossy(&b)));
        }
    }
    let st = |state: &str, goos: &str| {
        let (c, t) = sandbox::start_command(goos);
        RuntimeStatus {
            state: state.into(),
            os: goos.into(),
            runtime: "docker".into(),
            start_command: c,
            start_tryable: t,
            ..RuntimeStatus::default()
        }
    };
    let res = crate::sandbox_api::write_sandbox_runtime(&st(RUNTIME_STOPPED, "linux"));
    let b = res.into_body().collect().await.unwrap().to_bytes();
    out.push_str(&format!(
        "== runtime\n200 {}\n",
        q(&String::from_utf8_lossy(&b))
    ));
    let res = crate::sandbox_api::write_sandbox_start(
        &st(RUNTIME_MISSING, "darwin"),
        &|_: &str, _: &[String]| sandbox::RunOutput::ok(""),
    );
    let code = res.status().as_u16();
    let ec = res
        .headers()
        .get("x-error-code")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    let b = res.into_body().collect().await.unwrap().to_bytes();
    out.push_str(&format!(
        "== start\n{code} {ec} {}\n",
        q(&String::from_utf8_lossy(&b))
    ));
    for n in [0i128, 59, 60, 61, 1439, 1440, 2970, -5] {
        out.push_str(&format!(
            "dur {n} {}\n",
            crate::tools_api::fmt_duration(n * 60 * 1_000_000_000)
        ));
    }
    for b in [
        "",
        "null",
        "[1]",
        r#"{"claudeScrollSpeed":7.0}"#,
        r#"{"claudeScrollSpeed":1e30}"#,
        r#"{"claudeFullscreen":false,"claudeFullscreen":true}"#,
    ] {
        let e: Vec<String> = crate::agent_render_env::agent_render_env(b.as_bytes())
            .iter()
            .map(|s| q(s))
            .collect();
        out.push_str(&format!("env {} [{}]\n", q(b), e.join(" ")));
    }
    let host = otter_shared_platform::hostname().unwrap();
    let out = out.replace(&host, "HOST");
    let want = super::full_topics::without_migrated(include_str!("go_golden_552.txt"), None);
    let want = want.as_str();
    for (i, (g, w)) in out.lines().zip(want.lines()).enumerate() {
        assert_eq!(g, w, "{}번째 줄", i + 1);
    }
    assert_eq!(out, want);
}
