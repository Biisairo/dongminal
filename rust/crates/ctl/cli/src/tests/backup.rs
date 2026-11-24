//! backup_test.go — 홈 전체 backup/restore (M5 G4-3).

use std::collections::BTreeSet;
use std::fs::File;
use std::io::Write as _;
use std::path::Path;

use super::{Vars, args, with_env};
use crate::backup::{parse_backup, parse_restore, run_backup_in, run_restore_in, safe_join};
use crate::homelayout::DAEMON_SOCK_FILE;

fn seed_home() -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let home = d.path();
    for n in [
        "workspace.json",
        "settings.json",
        "access.json",
        "server.log",
        DAEMON_SOCK_FILE,
    ] {
        std::fs::write(home.join(n), format!("body-{n}")).unwrap();
    }
    std::fs::create_dir_all(home.join("notes")).unwrap();
    std::fs::write(home.join("notes").join("a.md"), "메모").unwrap();
    std::fs::create_dir_all(home.join("bin")).unwrap();
    d
}

fn entry_names(p: &Path) -> BTreeSet<String> {
    let mut z = zip::ZipArchive::new(File::open(p).unwrap()).unwrap();
    (0..z.len())
        .map(|i| String::from_utf8_lossy(z.by_index(i).unwrap().name_raw()).into_owned())
        .collect()
}

fn backup(home: &Path, out: &Path) -> (i32, String, String) {
    let o = parse_backup(&args(&["--out", out.to_str().unwrap()])).unwrap();
    let (mut so, mut se) = (Vec::new(), Vec::new());
    let code = with_env(&Vars::home(home), |env| {
        run_backup_in(&o, env, &mut so, &mut se)
    });
    (
        code,
        String::from_utf8(so).unwrap(),
        String::from_utf8(se).unwrap(),
    )
}

fn restore(home: &Path, a: &[&str]) -> (i32, String, String) {
    let o = parse_restore(&args(a)).unwrap();
    let (mut so, mut se) = (Vec::new(), Vec::new());
    let code = with_env(&Vars::home(home), |env| {
        run_restore_in(&o, env, &mut so, &mut se)
    });
    (
        code,
        String::from_utf8(so).unwrap(),
        String::from_utf8(se).unwrap(),
    )
}

// 소켓·pid·로그는 담기지 않는다 (DoD).
#[test]
fn excludes_ephemeral_files() {
    let h = seed_home();
    let t = tempfile::tempdir().unwrap();
    let out = t.path().join("b.zip");
    let (code, so, se) = backup(h.path(), &out);
    assert_eq!(code, 0, "{se}");
    assert_eq!(
        so,
        format!(
            "✅ 백업 4개 항목: {}\n   담기지 않은 것: 로그·소켓·pid·런타임 헬퍼 — 다음 기동이 다시 만듭니다.\n",
            out.display()
        )
    );
    let names = entry_names(&out);
    for n in [
        "workspace.json",
        "settings.json",
        "access.json",
        "notes/a.md",
    ] {
        assert!(names.contains(n), "{n} 가 없다: {names:?}");
    }
    for n in ["server.log", DAEMON_SOCK_FILE] {
        assert!(!names.contains(n), "{n} 가 담겼다");
    }
}

// 복원은 담긴 것을 되돌리고, 담기지 않은 것은 건드리지 않는다.
#[test]
fn restore_puts_files_back() {
    let h = seed_home();
    let home = h.path();
    let t = tempfile::tempdir().unwrap();
    let zip_path = t.path().join("b.zip");
    assert_eq!(backup(home, &zip_path).0, 0);

    std::fs::write(home.join("workspace.json"), "망가짐").unwrap();
    std::fs::remove_file(home.join("settings.json")).unwrap();

    let (code, so, se) = restore(home, &[zip_path.to_str().unwrap(), "--yes"]);
    assert_eq!(code, 0, "{se}");
    assert_eq!(
        so,
        format!(
            "홈: {}\n백업: {} (4개 항목)\n✅ 4개를 되돌렸습니다.\n   돌고 있는 서버가 있으면 다시 띄워야 반영됩니다.\n",
            home.display(),
            zip_path.display()
        )
    );
    for n in ["workspace.json", "settings.json", "access.json"] {
        assert_eq!(
            std::fs::read_to_string(home.join(n)).unwrap(),
            format!("body-{n}")
        );
    }
    assert_eq!(
        std::fs::read_to_string(home.join("notes").join("a.md")).unwrap(),
        "메모"
    );
    assert!(home.join("server.log").exists(), "복원이 로그를 지웠다");
}

// 복원은 되돌릴 수 없다 — 확인 없이는 하지 않는다.
#[test]
fn restore_requires_confirmation() {
    let h = seed_home();
    let home = h.path();
    let t = tempfile::tempdir().unwrap();
    let zip_path = t.path().join("b.zip");
    backup(home, &zip_path);
    std::fs::write(home.join("workspace.json"), "지금 값").unwrap();

    let (code, _, se) = restore(home, &[zip_path.to_str().unwrap()]);
    assert_eq!(code, 1);
    assert_eq!(
        std::fs::read_to_string(home.join("workspace.json")).unwrap(),
        "지금 값"
    );
    assert_eq!(
        se,
        "\n지금 홈의 파일을 덮어씁니다. 되돌릴 수 없습니다.\n진행하려면 --yes 를 함께 주세요.\n먼저 지금 것을 담아 두려면: otterminal backup --out <파일.zip>\n"
    );
}

// zip slip — 홈 밖을 가리키는 항목은 건너뛰고 그 사실을 말한다.
#[test]
fn restore_rejects_path_escape() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    std::fs::create_dir(&home).unwrap();
    let zip_path = root.path().join("evil.zip");
    let mut zw = zip::ZipWriter::new(File::create(&zip_path).unwrap());
    for name in ["../escaped.json", "/abs.json", "notes/../../out.json"] {
        zw.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zw.write_all(b"x").unwrap();
    }
    zw.finish().unwrap();

    let (code, so, se) = restore(&home, &[zip_path.to_str().unwrap(), "--yes"]);
    assert_eq!(code, 0);
    assert!(!root.path().join("escaped.json").exists(), "zip slip");
    assert!(!root.path().join("out.json").exists(), "zip slip");
    assert_eq!(
        se,
        "건너뜀 (홈 밖을 가리킵니다): ../escaped.json\n건너뜀 (홈 밖을 가리킵니다): /abs.json\n건너뜀 (홈 밖을 가리킵니다): notes/../../out.json\n"
    );
    assert!(
        so.contains("✅ 0개를 되돌렸습니다.\n   3개는 건너뛰었습니다 (홈 밖을 가리킴).\n"),
        "{so}"
    );
}

#[test]
fn safe_join_cases() {
    // 홈 아래 경로는 OS 구분자로 잇는다 (Go `filepath.Join` — Windows 는 `\h\a\b.json`).
    let want = |parts: &[&str]| otter_gocompat::filepath::join(parts);
    assert_eq!(
        safe_join("/h", "a/b.json"),
        Some(want(&["/h", "a", "b.json"]))
    );
    assert_eq!(
        safe_join("/h", "a/../b.json"),
        Some(want(&["/h", "b.json"]))
    );
    for bad in ["", "/x", "..", "../x", "a/../../x"] {
        assert_eq!(safe_join("/h", bad), None, "{bad}");
    }
}

// 백업에는 노드 개인키가 들어간다 — zip 은 소유자만 읽는다. 덮어써도 좁힌다.
#[cfg(unix)]
#[test]
fn backup_file_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let h = seed_home();
    let t = tempfile::tempdir().unwrap();
    let fresh = t.path().join("b.zip");
    let existing = t.path().join("old.zip");
    std::fs::write(&existing, "").unwrap();
    std::fs::set_permissions(&existing, std::fs::Permissions::from_mode(0o644)).unwrap();
    for out in [fresh, existing] {
        let (code, _, se) = backup(h.path(), &out);
        assert_eq!(code, 0, "{se}");
        let perm = std::fs::metadata(&out).unwrap().permissions().mode() & 0o777;
        assert_eq!(perm, 0o600, "{}", out.display());
    }
}
