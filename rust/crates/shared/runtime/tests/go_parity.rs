//! 설치 결과(경로·종류·권한·내용·symlink 대상)를 Go 와 바이트 단위로 비교한다 (FR-RSP-13).
//!
//! Go 참조는 `testdata/goref` 를 빌드해 같은 bin 자리에 설치한 결과다. 두 설치는 같은 경로에
//! 차례로 하므로 경로가 든 파일(claude.json·omp shim)도 그대로 비교된다. Go 참조는 `OTTER_GO_REF_SRC`
//! (main 의 worktree)가 있을 때만 `rust/scripts/go-ref.sh` 로 빌드한다. 없으면 건너뛴다 (GO_REMOVAL_SRS Q-GRM-4).
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

fn build_goref(out: &Path) -> Option<PathBuf> {
    std::env::var_os("OTTER_GO_REF_SRC")?;
    let exe = out.join("otterminal");
    let st = Command::new("bash")
        .arg(repo_root().join("rust/scripts/go-ref.sh"))
        .arg(&exe)
        .arg("rust/crates/shared/runtime/testdata/goref")
        .status()
        .unwrap();
    assert!(st.success(), "Go 참조 빌드 실패");
    Some(exe)
}

/// 경로 → (종류, 권한, 내용 또는 링크 대상).
fn snapshot(dir: &Path) -> Vec<(String, char, u32, Vec<u8>)> {
    fn walk(dir: &Path, rel: &str, out: &mut Vec<(String, char, u32, Vec<u8>)>) {
        let mut es: Vec<_> = fs::read_dir(dir).unwrap().map(Result::unwrap).collect();
        es.sort_by_key(fs::DirEntry::file_name);
        for e in es {
            let r = format!("{rel}{}", e.file_name().to_string_lossy());
            let m = fs::symlink_metadata(e.path()).unwrap();
            let perm = m.permissions().mode() & 0o7777;
            if m.file_type().is_symlink() {
                let t = fs::read_link(e.path()).unwrap();
                out.push((r, 'l', 0, t.to_string_lossy().into_owned().into_bytes()));
            } else if m.is_dir() {
                out.push((r.clone(), 'd', perm, Vec::new()));
                walk(&e.path(), &format!("{r}/"), out);
            } else {
                out.push((r, 'f', perm, fs::read(e.path()).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, "", &mut out);
    out
}

/// 같은 자리에 Go 로 한 번, Rust 로 한 번 설치하고 결과를 비교한다. seed 는 설치 전 상태를 만든다.
fn compare(name: &str, bin: &Path, self_exe: &Path, seed: &dyn Fn(&Path)) {
    let _ = fs::remove_dir_all(bin);
    seed(bin);
    let out = Command::new(self_exe).arg(bin).output().unwrap();
    assert!(
        out.status.success(),
        "{name}: go 설치 실패: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let go = snapshot(bin);
    fs::remove_dir_all(bin).unwrap();
    seed(bin);
    otter_shared_runtime::install_with(bin, self_exe).unwrap();
    let rust = snapshot(bin);
    let gp: Vec<_> = go.iter().map(|e| (&e.0, e.1, e.2)).collect();
    let rp: Vec<_> = rust.iter().map(|e| (&e.0, e.1, e.2)).collect();
    assert_eq!(gp, rp, "{name}: 경로·종류·권한이 다르다");
    for (g, r) in go.iter().zip(&rust) {
        assert!(
            g.3 == r.3,
            "{name}: {} 의 내용이 다르다\ngo:   {}\nrust: {}",
            g.0,
            String::from_utf8_lossy(&g.3),
            String::from_utf8_lossy(&r.3)
        );
    }
}

fn write(p: &Path, body: &str, mode: u32) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, body).unwrap();
    fs::set_permissions(p, fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
fn install_matches_go() {
    let work = tempfile::tempdir().unwrap();
    let Some(goref) = build_goref(work.path()) else {
        eprintln!("OTTER_GO_REF_SRC 가 없어 건너뛴다");
        return;
    };
    let goref = fs::canonicalize(goref).unwrap();
    let bin = work.path().join("home").join("bin");

    compare("fresh", &bin, &goref, &|_| {});

    // 묵은 상태: 폐지·기록에서 빠진 헬퍼, 묵은 플러그인·메모리 자산, 권한·내용이 틀린 설치물.
    compare("stale", &bin, &goref, &|b| {
        write(&b.join("mdview"), "x", 0o755);
        write(&b.join("옛헬퍼"), "x", 0o755);
        write(&b.join(".helpers"), "otterctl\n옛헬퍼\n../escape\n", 0o644);
        write(&b.join("agent-shims/옛shim"), "x", 0o755);
        write(&b.join("agent-shims/.helpers"), "claude\n옛shim\n", 0o644);
        write(&b.join("agent-plugin/skills/gone/SKILL.md"), "옛", 0o755);
        write(
            &b.join("agent-plugin/commands/issue-tree.md"),
            "stale",
            0o600,
        );
        write(&b.join("agent-memory/extra.md"), "x", 0o644);
        write(&b.join("bash-hook.sh"), "old", 0o644);
        write(&b.join("agent-hooks/claude.json"), "{}", 0o600);
        write(&b.join("user-file.txt"), "사용자", 0o644);
        fs::create_dir_all(b.join("otterctl")).unwrap();
    });

    // 덧없는 자기 경로(`go run`): 실체를 bin 안에 복사하고 헬퍼가 그것을 가리킨다.
    let go_build = tempfile::Builder::new()
        .prefix("go-build")
        .tempdir()
        .unwrap();
    let eph = go_build.path().join("b001").join("exe").join("otterminal");
    fs::create_dir_all(eph.parent().unwrap()).unwrap();
    fs::copy(&goref, &eph).unwrap();
    let eph = fs::canonicalize(eph).unwrap();
    compare("ephemeral", &bin, &eph, &|_| {});
}
