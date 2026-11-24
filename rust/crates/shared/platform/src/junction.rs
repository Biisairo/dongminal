//! 디렉터리 정션 (CLAUDE_ACCOUNTS_SRS FR-CAC-82). Windows 에만 있다.

use std::io;
use std::path::Path;

#[cfg(windows)]
const JUNCTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// link 에 target 을 가리키는 디렉터리 정션을 만든다. `cmd /c mklink /J link target`.
#[cfg(windows)]
pub fn junction(target: &Path, link: &Path) -> io::Result<()> {
    let cmd = crate::command_path("cmd").map_err(|m| io::Error::new(io::ErrorKind::NotFound, m))?;
    let mut child = std::process::Command::new(cmd)
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .spawn()?;
    let deadline = std::time::Instant::now() + JUNCTION_TIMEOUT;
    let status = loop {
        if let Some(st) = child.try_wait()? {
            break st;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            break child.wait()?;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    if status.success() {
        return Ok(());
    }
    // Go *exec.ExitError 의 문구.
    Err(io::Error::other(crate::exit_status_text(&status)))
}

/// Windows 가 아니면 언제나 실패다.
#[cfg(not(windows))]
pub fn junction(_target: &Path, _link: &Path) -> io::Result<()> {
    Err(io::Error::other("junction 은 Windows 에만 있다"))
}

#[cfg(all(test, not(windows)))]
mod tests {
    #[test]
    fn non_windows_fails() {
        let e = super::junction("a".as_ref(), "b".as_ref()).unwrap_err();
        assert_eq!(e.to_string(), "junction 은 Windows 에만 있다");
    }
}
