//! Go `*os.PathError`·`*os.LinkError` 모양의 오류 (FR-RSP-35).
//! dm-gocompat 이 같은 기능을 공개하면 이 두 함수의 몸통만 그것으로 바꾼다.

use std::io;
use std::path::Path;

/// Go `syscall.Errno` 문구에 가깝게 — std Display 의 ` (os error N)` 꼬리를 떼고 첫 글자를 낮춘다.
fn errno_text(e: &io::Error) -> String {
    let s = e.to_string();
    let s = match s.rfind(" (os error ") {
        Some(i) if s.ends_with(')') => &s[..i],
        _ => s.as_str(),
    };
    let mut cs = s.chars();
    match cs.next() {
        Some(c) => c.to_lowercase().chain(cs).collect(),
        None => String::new(),
    }
}

/// `op path: errno`.
pub(crate) fn path_err(op: &str, path: &Path, e: io::Error) -> io::Error {
    io::Error::new(
        e.kind(),
        format!("{op} {}: {}", path.display(), errno_text(&e)),
    )
}

/// `op old new: errno`.
pub(crate) fn link_err(op: &str, old: &Path, new: &Path, e: io::Error) -> io::Error {
    io::Error::new(
        e.kind(),
        format!(
            "{op} {} {}: {}",
            old.display(),
            new.display(),
            errno_text(&e)
        ),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn go_shapes() {
        let e = io::Error::from_raw_os_error(libc_enoent());
        let p = path_err("open", Path::new("/x/y"), e);
        assert_eq!(p.to_string(), "open /x/y: no such file or directory");
        assert_eq!(p.kind(), io::ErrorKind::NotFound);
        let l = link_err(
            "rename",
            Path::new("/a"),
            Path::new("/b"),
            io::Error::from_raw_os_error(libc_enoent()),
        );
        assert_eq!(l.to_string(), "rename /a /b: no such file or directory");
    }

    fn libc_enoent() -> i32 {
        2
    }
}
