//! Go `os` 의 파일 함수와 같은 오류 문구(`op path: errno`)를 내는 얇은 감쌈 (FR-RSP-35).

use std::fs;
use std::io::{self, Read};
use std::path::Path;

use otter_gocompat::oserr::path_error;

fn lossy(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Go `os.ReadFile`.
pub(crate) fn read_file(path: &Path) -> io::Result<Vec<u8>> {
    let mut f = fs::File::open(path).map_err(|e| path_error("open", &lossy(path), e))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| path_error("read", &lossy(path), e))?;
    Ok(buf)
}

/// Go `os.MkdirAll(path, perm)`.
pub(crate) fn mkdir_all(path: &Path, perm: u32) -> io::Result<()> {
    otter_gocompat::oserr::mkdir_all(&lossy(path), perm)
}
