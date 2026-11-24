//! 크래시 마커 (OBSERVABILITY_SRS 묶음 C). 읽기는 판정만 하고 파일을 고치지 않는다.

use std::path::{Path, PathBuf};

/// 마커가 사는 자리. `<home>` 아래이며 `doctor --bundle` 이 집는다 (FR-OBS-17).
pub const LAST_EXIT_FILE: &str = ".lastexit";

const MARK_RUNNING: &str = "running";
const MARK_CLEAN: &str = "clean";

/// 마지막 종료에 대한 판정.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LastExit {
    /// 마지막 기동이 정상 종료 경로를 지나지 않았다.
    pub crashed: bool,
    /// 마커가 아직 없다 — 비정상이 아니다 (FR-OBS-16).
    pub first: bool,
    /// 파일에 있던 내용. 진단이 그대로 싣는다.
    pub raw: String,
}

fn last_exit_path(home: &Path) -> PathBuf {
    home.join(LAST_EXIT_FILE)
}

/// 마커를 읽어 판정한다. 읽지 못한 것과 없는 것을 가르지 않는다. 알 수 없는 내용은 비정상이 아니다.
pub fn read_last_exit(home: &Path) -> LastExit {
    if home.as_os_str().is_empty() {
        return LastExit {
            first: true,
            ..LastExit::default()
        };
    }
    match std::fs::read(last_exit_path(home)) {
        Ok(data) => {
            let raw = String::from_utf8_lossy(&data).trim().to_owned();
            LastExit {
                crashed: raw == MARK_RUNNING,
                first: false,
                raw,
            }
        }
        Err(_) => LastExit {
            first: true,
            ..LastExit::default()
        },
    }
}

/// 기동 직후에 부른다. 실패를 돌려주지 않는다.
pub fn mark_running(home: &Path) {
    write_mark(home, MARK_RUNNING);
}

/// 정상 종료 경로에서 부른다.
pub fn mark_clean_exit(home: &Path) {
    write_mark(home, MARK_CLEAN);
}

/// 세대를 남기지 않는다. Go `os.WriteFile(…, 0600)` 과 같다.
fn write_mark(home: &Path, s: &str) {
    if home.as_os_str().is_empty() {
        return;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    if let Ok(mut f) = opts.open(last_exit_path(home)) {
        use std::io::Write;
        let _ = f.write_all(s.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_crash() {
        let d = tempfile::tempdir().unwrap();
        mark_running(d.path());
        let st = read_last_exit(d.path());
        assert!(st.crashed && !st.first, "{st:?}");
        assert_eq!(st.raw, "running");
    }

    #[test]
    fn clean_shutdown() {
        let d = tempfile::tempdir().unwrap();
        mark_running(d.path());
        mark_clean_exit(d.path());
        let st = read_last_exit(d.path());
        assert!(!st.crashed && !st.first, "{st:?}");
        assert_eq!(
            std::fs::read_to_string(d.path().join(LAST_EXIT_FILE)).unwrap(),
            "clean"
        );
    }

    #[test]
    fn first_boot() {
        let d = tempfile::tempdir().unwrap();
        let st = read_last_exit(d.path());
        assert!(!st.crashed && st.first);
        assert!(read_last_exit(Path::new("")).first);
    }

    #[test]
    fn read_does_not_mutate() {
        let d = tempfile::tempdir().unwrap();
        mark_running(d.path());
        assert_eq!(read_last_exit(d.path()), read_last_exit(d.path()));
    }

    #[test]
    fn unknown_content() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(d.path().join(".lastexit"), "뭐지").unwrap();
        assert!(!read_last_exit(d.path()).crashed);
    }

    #[test]
    fn file_name() {
        let d = tempfile::tempdir().unwrap();
        mark_running(d.path());
        assert!(d.path().join(".lastexit").exists());
    }
}
