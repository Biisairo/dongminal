//! Go `*os.PathError`·`*os.LinkError` 모양의 오류 (FR-RSP-35). `dm_gocompat::oserr` 에 경로를 넘긴다.

use std::io;
use std::path::Path;

use dm_gocompat::oserr::{link_error, path_error};

/// `op path: errno`.
pub(crate) fn path_err(op: &str, path: &Path, e: io::Error) -> io::Error {
    path_error(op, &path.to_string_lossy(), e)
}

/// `op old new: errno`.
pub(crate) fn link_err(op: &str, old: &Path, new: &Path, e: io::Error) -> io::Error {
    link_error(op, &old.to_string_lossy(), &new.to_string_lossy(), e)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    const ENOENT: i32 = 2;

    #[test]
    fn go_shapes() {
        let p = path_err(
            "open",
            Path::new("/x/y"),
            io::Error::from_raw_os_error(ENOENT),
        );
        assert_eq!(p.to_string(), "open /x/y: no such file or directory");
        assert_eq!(p.kind(), io::ErrorKind::NotFound);
        let l = link_err(
            "rename",
            Path::new("/a"),
            Path::new("/b"),
            io::Error::from_raw_os_error(ENOENT),
        );
        assert_eq!(l.to_string(), "rename /a /b: no such file or directory");
    }
}
