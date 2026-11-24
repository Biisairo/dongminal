//! 상태 파일의 세대 (STATE_FILE_DURABILITY_SRS 묶음 B).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use dm_shared_dmlog::infof;

use crate::atomic::write_file_atomic;
use crate::goerr::link_err;

/// 남기는 세대 수 (FR-SFD-2, 사용자 결정 2026-09-11).
pub const STATE_FILE_GENERATIONS: usize = 3;

/// 격리본(`.corrupt-<ts>`)과 되돌리기 직전 판(`.before-rollback-<ts>`)을 자동으로
/// 지우지 않는다는 결정 (`G4-6`, 사용자 2026-09-11). 회전하는 것은 `.bak.N` 뿐이다.
pub const RETAIN_QUARANTINED: bool = true;

/// n 번째 세대의 자리. 1 이 가장 최근이다.
fn gen_path(path: &Path, n: usize) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(format!(".bak.{n}"));
    PathBuf::from(s)
}

/// 상태 파일 하나를 쓰고 직전 내용을 세대로 남긴다 (FR-SFD-1). 같은 바이트면 아무것도 하지 않는다 (FR-SFD-7).
pub fn write_state_file(path: &Path, data: &[u8], perm: u32) -> io::Result<()> {
    write_state_file_gens(path, data, perm, STATE_FILE_GENERATIONS)
}

fn write_state_file_gens(path: &Path, data: &[u8], perm: u32, gens: usize) -> io::Result<()> {
    match fs::read(path) {
        Ok(cur) if cur == data => return Ok(()),
        Ok(cur) => rotate_generations(path, &cur, perm, gens),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => infof!(
            None,
            "state file: 세대 원본 읽기 {}: {}",
            path.display(),
            crate::goerr::path_err("open", path, e)
        ),
    }
    write_file_atomic(path, data, perm)
}

/// `n→버림 · … · 1→2 · 현재→1`. 실패해도 돌아간다 (FR-SFD-4).
fn rotate_generations(path: &Path, cur: &[u8], perm: u32, gens: usize) {
    if gens < 1 {
        return;
    }
    let _ = fs::remove_file(gen_path(path, gens));
    for i in (1..gens).rev() {
        let (from, to) = (gen_path(path, i), gen_path(path, i + 1));
        if let Err(e) = fs::rename(&from, &to)
            && e.kind() != io::ErrorKind::NotFound
        {
            infof!(
                None,
                "state file: 세대 회전 {}: {}",
                from.display(),
                link_err("rename", &from, &to, e)
            );
        }
    }
    // rename 하면 원본이 사라지는 순간이 생긴다 — 복사한다.
    let first = gen_path(path, 1);
    if let Err(e) = write_file_atomic(&first, cur, perm) {
        infof!(None, "state file: 세대 쓰기 {}: {e}", first.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_or_empty(p: &Path) -> String {
        fs::read_to_string(p).unwrap_or_default()
    }

    fn bak(p: &Path, n: usize) -> PathBuf {
        gen_path(p, n)
    }

    #[test]
    fn keeps_previous_generation() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("workspace.json");
        write_state_file(&p, b"v1", 0o644).unwrap();
        write_state_file(&p, b"v2", 0o644).unwrap();
        assert_eq!(read_or_empty(&p), "v2");
        assert_eq!(read_or_empty(&bak(&p, 1)), "v1");
    }

    #[test]
    fn rotates_three_generations() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s.json");
        for v in ["v1", "v2", "v3", "v4", "v5"] {
            write_state_file(&p, v.as_bytes(), 0o644).unwrap();
        }
        assert_eq!(read_or_empty(&p), "v5");
        assert_eq!(read_or_empty(&bak(&p, 1)), "v4");
        assert_eq!(read_or_empty(&bak(&p, 2)), "v3");
        assert_eq!(read_or_empty(&bak(&p, 3)), "v2");
        assert!(!bak(&p, 4).exists(), "세대는 셋이다");
    }

    #[test]
    fn generation_count_is_parameter() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s.json");
        for v in ["v1", "v2", "v3"] {
            write_state_file_gens(&p, v.as_bytes(), 0o644, 1).unwrap();
        }
        assert_eq!(read_or_empty(&bak(&p, 1)), "v2");
        assert!(!bak(&p, 2).exists());
    }

    #[test]
    fn first_write_makes_no_generation() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s.json");
        write_state_file(&p, b"v1", 0o644).unwrap();
        assert!(!bak(&p, 1).exists());
    }

    #[test]
    fn write_survives_rotation_failure() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s.json");
        write_state_file(&p, b"v1", 0o644).unwrap();
        fs::create_dir(bak(&p, 1)).unwrap();
        write_state_file(&p, b"v2", 0o644).expect("세대를 못 만들어도 저장은 된다 (FR-SFD-4)");
        assert_eq!(read_or_empty(&p), "v2");
    }

    #[test]
    fn retention_policy_is_explicit() {
        assert_eq!(STATE_FILE_GENERATIONS, 3);
        const { assert!(RETAIN_QUARANTINED) };
    }

    #[test]
    fn same_content_skips_rotation_and_write() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("s.json");
        for v in ["v1", "v2"] {
            write_state_file(&p, v.as_bytes(), 0o644).unwrap();
        }
        let before = crate::atomic::tests::file_id(&p);
        for _ in 0..3 {
            write_state_file(&p, b"v2", 0o644).unwrap();
        }
        assert_eq!(read_or_empty(&p), "v2");
        assert_eq!(read_or_empty(&bak(&p, 1)), "v1");
        assert!(!bak(&p, 2).exists(), "같은 내용 저장이 회전했다");
        assert_eq!(
            before,
            crate::atomic::tests::file_id(&p),
            "같은 내용인데 교체했다"
        );
    }
}
