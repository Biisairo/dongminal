//! 원자적 쓰기와 실행 파일 설치 (FR-CAF-8·10, FR-ATI-1·2·4).

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::goerr::{link_err, path_err};

const RENAME_TRIES: u32 = 10;
const RENAME_BACKOFF: Duration = Duration::from_millis(20);
const COPY_BUF: usize = 32 * 1024;

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// dst 를 원자적으로 덮기 위한 같은 디렉터리의 임시 이름 (FR-ATI-4). `<dst>.tmp<pid>.<n>`.
pub(crate) fn temp_sibling(dst: &Path) -> PathBuf {
    let n = TEMP_SEQ.fetch_add(1, Ordering::Relaxed) + 1;
    let mut s = dst.as_os_str().to_owned();
    s.push(format!(".tmp{}.{n}", std::process::id()));
    PathBuf::from(s)
}

/// Go `filepath.Dir` — 부모가 비면 ".".
pub(crate) fn parent_dir(path: &Path) -> PathBuf {
    match path.parent() {
        Some(p) if p.as_os_str().is_empty() => PathBuf::from("."),
        Some(p) => p.to_path_buf(),
        None => path.to_path_buf(),
    }
}

/// tmp 를 dst 로 옮긴다. 목적 경로를 비우지 않는다 (FR-ATI-1). 일시적 거부에는 물러섰다 다시 건다.
pub(crate) fn replace_file(tmp: &Path, dst: &Path) -> io::Result<()> {
    let mut last = None;
    for i in 0..RENAME_TRIES {
        match fs::rename(tmp, dst) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        std::thread::sleep(RENAME_BACKOFF * (i + 1));
    }
    let e = last.unwrap_or_else(|| io::Error::other("rename"));
    Err(link_err("rename", tmp, dst, e))
}

/// Go `os.Chmod`. Windows 는 0200 비트로 읽기 전용 속성만 바꾼다.
pub(crate) fn chmod(path: &Path, perm: u32) -> io::Result<()> {
    #[cfg(unix)]
    let p = {
        use std::os::unix::fs::PermissionsExt;
        fs::Permissions::from_mode(perm & 0o7777)
    };
    #[cfg(not(unix))]
    let p = {
        let mut p = fs::metadata(path)
            .map_err(|e| path_err("chmod", path, e))?
            .permissions();
        p.set_readonly(perm & 0o200 == 0);
        p
    };
    fs::set_permissions(path, p).map_err(|e| path_err("chmod", path, e))
}

/// Go `FileMode.Perm()` 의 값. Windows 는 읽기 전용이면 0444, 아니면 0666 이다.
pub(crate) fn file_perm(meta: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        if meta.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}

fn open_with_mode(path: &Path, opts: &mut OpenOptions, perm: u32) -> io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(perm);
    }
    #[cfg(not(unix))]
    let _ = perm;
    opts.open(path).map_err(|e| path_err("open", path, e))
}

/// 디렉터리 dir 를 fsync 한다 (FR-ATF-58). Windows 는 할 일이 없다.
pub(crate) fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        let d = File::open(dir).map_err(|e| path_err("open", dir, e))?;
        d.sync_all().map_err(|e| path_err("sync", dir, e))
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// data 를 path 에 통째로 쓴다 (FR-CAF-8). 실패해도 목적 파일의 기존 내용은 그대로다 (FR-CAF-10).
pub fn write_file_atomic(path: &Path, data: &[u8], perm: u32) -> io::Result<()> {
    write_file_atomic_with(path, data, perm, sync_dir)
}

pub(crate) fn write_file_atomic_with(
    path: &Path,
    data: &[u8],
    perm: u32,
    dir_sync: impl Fn(&Path) -> io::Result<()>,
) -> io::Result<()> {
    let tmp = temp_sibling(path);
    let mut f = open_with_mode(&tmp, OpenOptions::new().write(true).create_new(true), perm)?;
    let staged = f
        .write_all(data)
        .map_err(|e| path_err("write", &tmp, e))
        .and_then(|()| f.sync_all().map_err(|e| path_err("sync", &tmp, e)));
    drop(f);
    let done = staged
        .and_then(|()| chmod(&tmp, perm))
        .and_then(|()| replace_file(&tmp, path));
    if let Err(e) = done {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    // 이미 바뀐 뒤라 실패해도 쓰기는 성공이다 (FR-ATF-58).
    if let Err(e) = dir_sync(&parent_dir(path)) {
        otter_shared_otterlog::warnf!(None, "WriteFileAtomic: 디렉터리 fsync: {e}");
    }
    Ok(())
}

/// 설치물을 쓴다 (FR-OPT-5-5). 내용이 같으면 쓰지 않고 권한만 맞춘다.
pub fn write_file_if_changed(path: &Path, data: &[u8], perm: u32) -> io::Result<()> {
    match fs::read(path) {
        Ok(cur) if cur == data => {}
        _ => return write_file_atomic(path, data, perm),
    }
    let meta = fs::metadata(path).map_err(|e| path_err("stat", path, e))?;
    if file_perm(&meta) == perm {
        return Ok(());
    }
    chmod(path, perm)
}

/// 심볼릭 링크를 쓰지 않고 실체를 복사한다 (HELPER_INSTALL_SRS FR-HLI-1).
pub fn copy_executable(src: &Path, dst: &Path) -> io::Result<()> {
    let mut input = File::open(src).map_err(|e| path_err("open", src, e))?;
    let tmp = temp_sibling(dst);
    let mut out = open_with_mode(
        &tmp,
        OpenOptions::new().write(true).create(true).truncate(true),
        0o755,
    )?;
    if let Err(e) = copy_stream(&mut input, src, &mut out, &tmp) {
        drop(out);
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    drop(out);

    if let Err(err) = replace_file(&tmp, dst) {
        // Windows 는 실행 중인 파일을 덮지 못하지만 이름은 바꿀 수 있다 — 옆으로 밀어내고 다시 건다.
        let mut aside = dst.as_os_str().to_owned();
        aside.push(".old");
        let aside = PathBuf::from(aside);
        go_remove(&aside);
        if fs::rename(dst, &aside).is_err() {
            let _ = fs::remove_file(&tmp);
            return Err(err);
        }
        if let Err(rerr) = replace_file(&tmp, dst) {
            let _ = fs::rename(&aside, dst);
            let _ = fs::remove_file(&tmp);
            return Err(rerr);
        }
        go_remove(&aside);
    }
    Ok(())
}

/// Go `os.Remove`: 파일을 지우고, 안 되면 빈 디렉터리로 지운다. 실패는 삼킨다.
fn go_remove(p: &Path) {
    if fs::remove_file(p).is_err() {
        let _ = fs::remove_dir(p);
    }
}

fn copy_stream(r: &mut File, rp: &Path, w: &mut File, wp: &Path) -> io::Result<()> {
    let mut buf = vec![0u8; COPY_BUF];
    loop {
        let n = match r.read(&mut buf) {
            Ok(0) => return Ok(()),
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(path_err("read", rp, e)),
        };
        w.write_all(&buf[..n])
            .map_err(|e| path_err("write", wp, e))?;
    }
}

#[cfg(test)]
pub(crate) mod tests;
