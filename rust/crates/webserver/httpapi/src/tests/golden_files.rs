//! 파일·탐색기·편집기 종단을 go1.27.2 의 실제 핸들러가 낸 응답(상태·머리·본문)과 바이트 단위로
//! 대조한다. 기대값 `go_golden_files.json` 은 Go `New(...).Handler()` 에 같은 고정 자료·같은 요청을
//! 넣어 뽑았다(경로만 `{ROOT}`·`{DATA}` 자리표시자, 본문은 hex). 쓰기 응답의 표식은 시각이 들어가
//! 비교에서 지운다.

use std::sync::Arc;
use std::time::{Duration, SystemTime};

use dm_shared_textenc::{self as textenc, Encoded};
use dm_webserver_domain_wsentry::{self as wsentry, normalize_path};
use serde::Deserialize;

use super::fsenv::{FakeHub, FakeWork, req, set_home};
use crate::{Config, Deps, Server, ToolHub};

#[derive(Deserialize)]
struct Case {
    m: String,
    target: String,
    ct: String,
    body: String,
    status: u16,
    headers: Option<Vec<String>>,
    resp: String,
}

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

fn set_mtime(p: &str, t: SystemTime) {
    std::fs::File::open(p).unwrap().set_modified(t).unwrap();
}

#[tokio::test]
async fn files_match_go_golden() {
    let b = tempfile::tempdir().unwrap();
    let base = normalize_path(&b.path().to_string_lossy());
    let root = format!("{base}/proj");
    let d = tempfile::tempdir().unwrap();
    let data = normalize_path(&d.path().to_string_lossy());
    let Encoded::Bytes(cp) = textenc::encode("한글 파일\n", textenc::CP949, false).unwrap()
    else {
        panic!()
    };
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend_from_slice(&[0; 32]);
    let files: Vec<(&str, Vec<u8>)> = vec![
        ("k.txt", cp),
        ("bad.txt", vec![0xFF, 0xFF, 0x80]),
        ("a.txt", b"hello\n".to_vec()),
        ("pic.png", png),
        (
            "icon.svg",
            br#"<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>"#.to_vec(),
        ),
        ("page.html", b"<html><script>x</script></html>".to_vec()),
        ("한글 파일.txt", b"x".to_vec()),
        (".hidden", Vec::new()),
        ("up/dup.txt", b"x".to_vec()),
        ("sub/keep.txt", b"keep".to_vec()),
    ];
    for dir in ["sub", "up", "B"] {
        std::fs::create_dir_all(format!("{root}/{dir}")).unwrap();
    }
    let fixed = SystemTime::UNIX_EPOCH + Duration::new(1_700_000_000, 123_456_789);
    for (n, b) in &files {
        let p = format!("{root}/{n}");
        std::fs::write(&p, b).unwrap();
        set_mtime(&p, fixed);
    }
    for dir in ["/sub", "/up", "/B", ""] {
        set_mtime(&format!("{root}{dir}"), fixed);
    }

    let hub: Arc<dyn ToolHub> = FakeHub::with_cwd("p1", &format!("{root}/up"));
    let r = root.clone();
    let srv = Server::new_with(
        Config {
            data_dir: d.path().to_path_buf(),
            ..Config::default()
        },
        Deps {
            work: Some(Arc::new(FakeWork::default())),
            tools: Some(hub),
            ..Deps::default()
        },
        |s| {
            s.limits.upload_max_bytes = 400;
            set_home(s, &r);
        },
    );
    srv.entries
        .mutate(|mut cur: wsentry::Lists| {
            cur.editors.push(root.clone());
            cur
        })
        .unwrap();

    let stamp = regex::Regex::new(r#""stamp":"[0-9a-f-]+""#).unwrap();
    let norm = |s: &str| {
        let s = s.replace(&root, "{ROOT}").replace(&data, "{DATA}");
        stamp.replace_all(&s, r#""stamp":"-""#).into_owned()
    };
    let cases: Vec<Case> = serde_json::from_str(include_str!("go_golden_files.json")).unwrap();
    for c in cases {
        let target = c.target.replace("{ROOT}", &root);
        let body = String::from_utf8(hex::decode(&c.body).unwrap())
            .unwrap()
            .replace("{ROOT}", &root);
        let res = req(&srv, &c.m, &target, &c.ct, body).await;
        let mut hs: Vec<String> = res
            .headers
            .iter()
            // `Connection: close` 는 Go 실서버(`MaxBytesReader`)가 쓰고 `httptest` 기록기는 쓰지 않는다.
            .filter(|(k, _)| k.as_str() != "x-request-id" && k.as_str() != "connection")
            .map(|(k, v)| {
                format!(
                    "{}={}",
                    canon(k.as_str()),
                    norm(&String::from_utf8_lossy(v.as_bytes()))
                )
            })
            .collect();
        hs.sort();
        let got = (res.status, hs, norm(&String::from_utf8_lossy(&res.body)));
        let resp = hex::decode(&c.resp).unwrap();
        let want = (
            c.status,
            c.headers.unwrap_or_default(),
            norm(&String::from_utf8_lossy(&resp)),
        );
        assert_eq!(got, want, "{} {} {}", c.m, c.target, c.ct);
        // 본문 바이트도 그대로 같아야 한다(이진·CP949 응답). 쓰기 응답은 표식이 시각이다.
        if c.target != "/api/file/write" {
            let raw = replace_bytes(&replace_bytes(&res.body, &root, "{ROOT}"), &data, "{DATA}");
            assert_eq!(raw, resp, "{} {}", c.m, c.target);
        }
    }
}

fn replace_bytes(b: &[u8], from: &str, to: &str) -> Vec<u8> {
    let from = from.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i..].starts_with(from) {
            out.extend_from_slice(to.as_bytes());
            i += from.len();
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}
