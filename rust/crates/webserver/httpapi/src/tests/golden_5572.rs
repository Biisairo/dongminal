//! 탐색기 검색·무시·감시·zip 종단을 go1.27.2 의 실제 핸들러가 낸 응답과 바이트 단위로 대조한다.
//! 기대값 `go_golden_5572.json` 은 Go `New(...).Handler()` 에 같은 고정 자료·같은 요청을 넣어
//! 뽑았다(경로만 `{ROOT}`, 본문은 hex). zip 본문은 deflate 스트림만 Go 와 다르므로(SRS 3.7
//! DIFF-24) 양쪽을 풀어 압축 크기·위치 칸을 지운 꼴로 대조한다 — 나머지 컨테이너 바이트는 같다.
//! `fn` 은 Go `grepWithGo`·`findFiles` 를 직접 부른 결과다(ripgrep 이 없는 호스트의 경로).

use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use otter_webserver_domain_wsentry::{self as wsentry, normalize_path};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use super::fsenv::{FakeWork, req, set_home};
use crate::fs_search::{find_files, grep_with_go};
use crate::{Config, Deps, Server};

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

#[derive(Deserialize)]
struct FnCase {
    kind: String,
    q: String,
    limit: usize,
    out: String,
}

#[derive(Deserialize)]
struct Golden {
    http: Vec<Case>,
    #[serde(rename = "fn")]
    fns: Vec<FnCase>,
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

/// Go 생성기와 같은 고정 자료다.
pub(crate) fn fixture(root: &str) {
    let files: &[(&str, &[u8])] = &[
        ("src/app.go", b"package main\nfunc Handler() {}\n"),
        (
            "src/util/helper.go",
            "package util\n// Handler 를 돕는다\n".as_bytes(),
        ),
        ("src/app.test.js", b"test('Handler', () => {})\n"),
        ("README.md", b"no match here\n"),
        ("node_modules/pkg/app.go", b"func Handler() {}\n"),
        (".git/config", b"Handler\n"),
        ("bin/blob.dat", b"Handler\x00\x01\x02binary\n"),
        ("crlf.txt", b"alpha\r\nxx NEEDLE\r\nomega\r\n"),
        ("noeol.txt", b"alpha\nNEEDLE last"),
        ("uni.txt", "İİ Ünique MARK <&>\n".as_bytes()),
        ("bad.txt", b"\xff\xfe badmark \xe2\x82\n"),
        ("meta.txt", b"value=$(id); rm -rf /\n"),
        ("한글 폴더/a.txt", b"x"),
        ("box/a.txt", b"aaa\n"),
        ("box/sub/b.txt", b"bbb\n"),
        ("box/sub/deep/c.txt", b"ccc\n"),
        ("top.txt", b"top\n"),
        ("other/sub/x.txt", b"x\n"),
        ("many/hit1.txt", b"x"),
        ("many/hit2.txt", b"x"),
        ("many/hit3.txt", b"x"),
        ("repo/.gitignore", b"node_modules/\n*.log\ntracked.log\n"),
        ("repo/node_modules/pkg/a.js", b"x\n"),
        ("repo/src/main.js", b"x\n"),
        ("repo/app.log", b"x\n"),
        ("repo/tracked.log", b"x\n"),
    ];
    let long = format!("ab{} LONGMARK\n", "가".repeat(200));
    let fixed = SystemTime::UNIX_EPOCH + Duration::new(1_700_000_000, 123_456_789);
    let mut all: Vec<(&str, &[u8])> = files.to_vec();
    all.push(("long.txt", long.as_bytes()));
    for (n, b) in all {
        let p = format!("{root}/{n}");
        std::fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
        std::fs::write(&p, b).unwrap();
        std::fs::File::open(&p)
            .unwrap()
            .set_modified(fixed)
            .unwrap();
    }
    std::fs::create_dir_all(format!("{root}/box/empty")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let set = |p: &str, m| {
            std::fs::set_permissions(format!("{root}/{p}"), std::fs::Permissions::from_mode(m))
                .unwrap();
        };
        set("box/sub/b.txt", 0o444);
        set("box/a.txt", 0o755);
        std::os::unix::fs::symlink(format!("{root}/box/a.txt"), format!("{root}/box/link.txt"))
            .unwrap();
        std::os::unix::fs::symlink(root, format!("{root}/src/loop")).unwrap();
    }
    let repo = Path::new(root).join("repo");
    for args in [
        &["init", "-b", "main"][..],
        &["config", "user.email", "t@example.com"],
        &["config", "user.name", "tester"],
        &["add", "-f", "tracked.log"],
        &["add", ".gitignore", "src"],
        &["commit", "-m", "init"],
    ] {
        otter_shared_gittest::run(&repo, args);
    }
}

fn u16_at(b: &[u8], i: usize) -> usize {
    usize::from(u16::from_le_bytes([b[i], b[i + 1]]))
}

fn u32_at(b: &[u8], i: usize) -> usize {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize
}

/// zip 하나를 압축과 무관한 꼴로 편다: 엔트리마다 로컬 머리·풀어 낸 내용·(압축 크기를 지운)
/// 데이터 기술자, 그리고 (압축 크기·위치를 지운) 중앙 디렉터리와 (위치를 지운) 끝 레코드.
pub(crate) fn zip_canon(z: &[u8]) -> Vec<u8> {
    let eocd = z.len() - 22;
    assert_eq!(&z[eocd..eocd + 4], b"PK\x05\x06");
    let records = u16_at(z, eocd + 10);
    let cd = u32_at(z, eocd + 16);
    let mut out = Vec::new();
    let mut p = cd;
    let mut central = Vec::new();
    for _ in 0..records {
        assert_eq!(&z[p..p + 4], b"PK\x01\x02");
        let flags = u16_at(z, p + 8);
        let method = u16_at(z, p + 10);
        let csize = u32_at(z, p + 20);
        let (n, e, c) = (u16_at(z, p + 28), u16_at(z, p + 30), u16_at(z, p + 32));
        let off = u32_at(z, p + 42);
        let mut ent = z[p..p + 46 + n + e + c].to_vec();
        ent[20..24].fill(0);
        ent[42..46].fill(0);
        central.extend_from_slice(&ent);
        p += 46 + n + e + c;
        let (ln, le) = (u16_at(z, off + 26), u16_at(z, off + 28));
        let ds = off + 30 + ln + le;
        out.extend_from_slice(&z[off..ds]);
        let data = &z[ds..ds + csize];
        if method == 8 {
            let mut raw = Vec::new();
            flate2::read::DeflateDecoder::new(data)
                .read_to_end(&mut raw)
                .unwrap();
            out.extend_from_slice(&raw);
        } else {
            out.extend_from_slice(data);
        }
        if flags & 0x8 != 0 {
            let mut dd = z[ds + csize..ds + csize + 16].to_vec();
            dd[8..12].fill(0);
            out.extend_from_slice(&dd);
        }
    }
    out.extend_from_slice(&central);
    let mut end = z[eocd..].to_vec();
    end[16..20].fill(0);
    out.extend_from_slice(&end);
    out
}

#[tokio::test]
async fn search_ignore_watch_zip_match_go_golden() {
    if otter_shared_gittest::path().is_none() {
        return;
    }
    let b = tempfile::tempdir().unwrap();
    let base = normalize_path(&b.path().to_string_lossy());
    let root = format!("{base}/proj");
    fixture(&root);
    let d = tempfile::tempdir().unwrap();
    let r = root.clone();
    let srv = Server::new_with(
        Config {
            data_dir: d.path().to_path_buf(),
            ..Config::default()
        },
        Deps {
            work: Some(Arc::new(FakeWork::default())),
            ..Deps::default()
        },
        |s| set_home(s, &r),
    );
    srv.entries
        .mutate(|mut cur: wsentry::Lists| {
            cur.editors.push(root.clone());
            cur
        })
        .unwrap();
    srv.fs.watch.as_ref().unwrap().attach("c1");

    let g: Golden = serde_json::from_str(include_str!("go_golden_5572.json")).unwrap();
    for c in g.http {
        let target = c.target.replace("{ROOT}", &root);
        let body = String::from_utf8(hex::decode(&c.body).unwrap())
            .unwrap()
            .replace("{ROOT}", &root);
        let res = req(&srv, &c.m, &target, &c.ct, body).await;
        let mut hs: Vec<String> = res
            .headers
            .iter()
            .filter(|(k, _)| k.as_str() != "x-request-id" && k.as_str() != "connection")
            .map(|(k, v)| {
                format!(
                    "{}={}",
                    canon(k.as_str()),
                    String::from_utf8_lossy(v.as_bytes()).replace(&root, "{ROOT}")
                )
            })
            .collect();
        hs.sort();
        let want = hex::decode(&c.resp).unwrap();
        let (got_body, want_body) = if want.starts_with(b"PK") {
            (zip_canon(&res.body), zip_canon(&want))
        } else {
            (
                String::from_utf8_lossy(&res.body)
                    .replace(&root, "{ROOT}")
                    .into_bytes(),
                want,
            )
        };
        assert_eq!(
            (res.status, hs, String::from_utf8_lossy(&got_body)),
            (
                c.status,
                c.headers.unwrap_or_default(),
                String::from_utf8_lossy(&want_body)
            ),
            "{} {}",
            c.m,
            c.target
        );
        assert_eq!(got_body, want_body, "{} {}", c.m, c.target);
    }

    let ctx = CancellationToken::new();
    for f in g.fns {
        let got = if f.kind == "grep" {
            let (m, t) = grep_with_go(&ctx, &root, &f.q, f.limit).unwrap();
            #[derive(serde::Serialize)]
            struct O {
                m: Vec<crate::fs_search::GrepMatch>,
                t: bool,
            }
            otter_gocompat::json::marshal(&O { m, t }).unwrap()
        } else {
            let (fl, t) = find_files(&ctx, &root, &f.q, f.limit).unwrap();
            #[derive(serde::Serialize)]
            struct O {
                f: Vec<crate::fs_search::FindHit>,
                t: bool,
            }
            otter_gocompat::json::marshal(&O { f: fl, t }).unwrap()
        };
        assert_eq!(
            String::from_utf8_lossy(&got),
            f.out,
            "{} {:?} {}",
            f.kind,
            f.q,
            f.limit
        );
    }
}
