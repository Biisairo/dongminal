//! bundle_test.go — 신고에 붙일 것이 있고, 비밀은 새지 않는다 (G2-3).

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use super::{Vars, with_env};
use crate::bundle::{bundle_about, bundle_home_listing};
use crate::doctor::run_doctor_in;
use crate::options::DoctorOpts;
use crate::version::{GO_RUNTIME, VERSION};

fn zip_entries(p: &Path) -> BTreeMap<String, String> {
    let mut z = zip::ZipArchive::new(File::open(p).expect("번들을 열 수 없다")).unwrap();
    let mut out = BTreeMap::new();
    for i in 0..z.len() {
        let mut f = z.by_index(i).unwrap();
        let name = String::from_utf8_lossy(f.name_raw()).into_owned();
        let mut s = String::new();
        f.read_to_string(&mut s).unwrap();
        out.insert(name, s);
    }
    out
}

fn bundle_home() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let h = d.path();
    std::fs::write(h.join("settings.json"), r#"{"themeName":"dark"}"#).unwrap();
    std::fs::write(h.join("access.json"), r#"{"enabled":true}"#).unwrap();
    std::fs::write(h.join("server.log"), "line1\nline2\n").unwrap();
    d
}

/// `OTTERMINAL_HOME` 으로 홈을 고르고 `doctor --bundle out` 을 돌린다.
fn run(home: &Path, out: &Path) -> (i32, String, String) {
    let o = DoctorOpts {
        bundle: out.to_str().unwrap().to_owned(),
        ..DoctorOpts::default()
    };
    let (mut so, mut se) = (Vec::new(), Vec::new());
    let code = with_env(&Vars::home(home), |env| {
        run_doctor_in(&o, env, &mut so, &mut se)
    });
    (
        code,
        String::from_utf8(so).unwrap(),
        String::from_utf8(se).unwrap(),
    )
}

#[test]
fn has_what_we_always_ask() {
    let h = bundle_home();
    let t = tempfile::tempdir().unwrap();
    let out = t.path().join("b.zip");
    let (code, so, se) = run(h.path(), &out);
    assert_eq!(code, 0, "{se}");
    assert_eq!(
        so,
        format!(
            "✅ 진단 번들: {}\n   붙이기 전에 한 번 열어 확인해 주세요 — 담는 것을 좁혔지만 최종 판단은 보내는 분의 것입니다.\n",
            out.display()
        )
    );
    let names = zip_entries(&out);
    assert_eq!(
        names.keys().map(String::as_str).collect::<Vec<_>>(),
        [
            "about.txt",
            "access.json",
            "home-files.txt",
            "logs/server.log",
            "settings.json"
        ]
    );
    assert_eq!(names["settings.json"], r#"{"themeName":"dark"}"#);
    assert_eq!(names["logs/server.log"], "line1\nline2\n");
    assert!(
        names["about.txt"].contains("version"),
        "{}",
        names["about.txt"]
    );
}

// 자격증명이 새지 않는다 — 카나리아.
#[test]
fn masks_credentials() {
    let h = bundle_home();
    const CANARY: &str = "SUPERSECRET";
    std::fs::write(
        h.path().join("server.log"),
        format!("remote https://user:{CANARY}@github.com/x/y.git\n"),
    )
    .unwrap();
    let t = tempfile::tempdir().unwrap();
    let out = t.path().join("b.zip");
    assert_eq!(run(h.path(), &out).0, 0);
    for (name, body) in zip_entries(&out) {
        assert!(
            !body.contains(CANARY),
            "{name} 에 자격증명이 남았다:\n{body}"
        );
    }
}

// 홈 파일 목록은 이름과 크기이지 내용이 아니다.
#[test]
fn home_listing_is_names_only() {
    let h = bundle_home();
    std::fs::write(h.path().join("workspace.json"), r#"{"secret-layout":1}"#).unwrap();
    std::fs::create_dir(h.path().join("notes")).unwrap();
    let listing = bundle_home_listing(h.path().to_str().unwrap());
    assert!(!listing.contains("secret-layout"), "{listing}");
    let want_ws = format!("{:<40} {:<5} {}", "workspace.json", "file", 19);
    let want_dir = format!("{:<40} {:<5} ", "notes", "dir");
    assert!(listing.lines().any(|l| l == want_ws), "{listing}");
    assert!(
        listing.lines().any(|l| l.starts_with(&want_dir)),
        "{listing}"
    );
    assert!(listing.ends_with('\n'));
}

#[test]
fn unreadable_home_listing() {
    assert_eq!(bundle_home_listing("/없는/홈"), "(홈을 읽을 수 없습니다)\n");
}

#[test]
fn about_has_no_home_path() {
    let h = tempfile::tempdir().unwrap();
    let home = h.path().to_str().unwrap();
    let about = bundle_about(home);
    assert!(!about.contains(home), "{about}");
    assert!(
        about.starts_with(&format!(
            "version: {VERSION}\ntarget: {}\ngo: {GO_RUNTIME}\nhome-exists: true\nlast-exit: ",
            otter_shared_platform::build_target()
        )),
        "{about}"
    );
}

#[test]
fn cannot_create() {
    let h = bundle_home();
    let (code, so, se) = run(h.path(), Path::new("/없는/곳/b.zip"));
    assert_eq!(code, 1);
    assert!(so.is_empty());
    // 끝의 OS 오류 문구는 Go 와 같이 OS 의 것이다.
    let os_msg = if cfg!(windows) {
        "The system cannot find the path specified."
    } else {
        "no such file or directory"
    };
    assert_eq!(
        se,
        format!("번들을 만들 수 없습니다: open /없는/곳/b.zip: {os_msg}\n")
    );
}
