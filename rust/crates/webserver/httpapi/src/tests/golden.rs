//! go1.27.2 의 실제 httpapi 핸들러가 낸 응답(상태·머리·본문)과 바이트 단위로 대조한다.
//! 기대값 `go_golden.txt` 는 Go 핸들러에 같은 요청을 넣어 뽑았다(호스트명만 자리표시자).

use super::support::*;
use crate::Deps;

fn canon(k: &str) -> String {
    k.split('-')
        .map(|p| {
            let mut c = p.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

#[tokio::test]
async fn responses_match_go_golden() {
    let d = tempfile::tempdir().unwrap();
    let srv = server(d.path(), Deps::default());
    let st = srv.access.as_ref().unwrap();
    quiet(st);
    st.refresh();
    let j = "application/json";
    type Case<'a> = (&'a str, &'a str, &'a str, &'a str, &'a str, Option<&'a str>);
    let reqs: Vec<Case> = vec![
        (
            "GET",
            "/api/ping",
            "127.0.0.1:58146",
            "",
            "127.0.0.1:5000",
            None,
        ),
        (
            "GET",
            "/api/access",
            "LocalHost:1",
            "",
            "100.117.248.111:5000",
            None,
        ),
        (
            "PUT",
            "/api/access",
            "127.0.0.1:58146",
            "{nope",
            "127.0.0.1:5000",
            Some(j),
        ),
        (
            "PUT",
            "/api/access",
            "127.0.0.1:58146",
            r#"{"enabled":true,"entries":[{"id":"a","value":"nope!!","enabled":true}]}"#,
            "127.0.0.1:5000",
            Some(j),
        ),
        (
            "PUT",
            "/api/access",
            "127.0.0.1:58146",
            r#"{"enabled":false,"entries":[{"id":"a","value":"10.0.0.1","enabled":true}]}"#,
            "127.0.0.1:5000",
            Some(j),
        ),
        (
            "GET",
            "/api/access",
            "127.0.0.1:58146",
            "",
            "127.0.0.1:5000",
            None,
        ),
        (
            "POST",
            "/api/access/check",
            "127.0.0.1:58146",
            r#"{"enabled":true,"entries":[{"id":"a","value":"10.0.0.0/8","enabled":true}]}"#,
            "192.0.2.1:1234",
            Some(j),
        ),
        ("GET", "/foo", "127.0.0.1:58146", "", "127.0.0.1:5000", None),
        ("GET", "/api", "127.0.0.1:58146", "", "127.0.0.1:5000", None),
        (
            "GET",
            "/api/nope",
            "127.0.0.1:58146",
            "",
            "127.0.0.1:5000",
            None,
        ),
        (
            "GET",
            "/api/state",
            "evil.example",
            "",
            "127.0.0.1:5000",
            None,
        ),
        (
            "POST",
            "/api/tools/headless",
            "127.0.0.1:58146",
            "{}",
            "127.0.0.1:5000",
            Some("text/plain"),
        ),
        (
            "GET",
            "/api/tools/output?id=p1",
            "127.0.0.1:58146",
            "",
            "127.0.0.1:5000",
            None,
        ),
        (
            "POST",
            "/api/tools/input",
            "127.0.0.1:58146",
            "{bad",
            "127.0.0.1:5000",
            Some(j),
        ),
    ];
    let mut out = String::new();
    for (m, p, host, body, remote, ct) in reqs {
        let mut h = vec![("Host", host)];
        if let Some(c) = ct {
            h.push(("Content-Type", c));
        }
        let r = call(&srv, m, p, &h, body, remote).await;
        let mut hs: Vec<String> = r
            .headers
            .iter()
            .filter(|(k, _)| k.as_str() != "x-request-id")
            .map(|(k, v)| format!("{}={}", canon(k.as_str()), v.to_str().unwrap()))
            .collect();
        hs.sort();
        out.push_str(&format!(
            "== {m} {p}\n{} {}\n{:?}\n",
            r.status,
            hs.join("|"),
            r.body
        ));
    }
    let hn = srv.hosts.hostname.clone();
    let want = include_str!("go_golden.txt").replace("{HOSTNAME}", &hn);
    assert_eq!(out, want);
}
