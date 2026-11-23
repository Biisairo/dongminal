//! 이 crate 가 쓰는 OS 호출. Go 판도 `golang.org/x/sys/unix`·`os` 로 직접 부른다.

use std::io;
use std::path::Path;

use dm_shared_platform::IpcStream;

/// 이 OS 에 도우미가 있는가다 (FR-PCH-79).
pub(crate) const SUPPORTED: bool = cfg!(target_os = "macos");

/// 접속한 프로세스의 OS 사용자. macOS 는 LOCAL_PEERCRED, 그 밖에는 아직 없어 모두 끊는다.
pub(crate) fn peer_uid(c: &IpcStream) -> io::Result<i64> {
    #[cfg(target_os = "macos")]
    {
        use nix::sys::socket::{getsockopt, sockopt::LocalPeerCred};
        getsockopt(c, LocalPeerCred)
            .map(|cred| i64::from(cred.uid()))
            .map_err(io::Error::from)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = c;
        Err(io::Error::other("이 OS 의 도우미는 아직 없다"))
    }
}

pub(crate) fn geteuid() -> i64 {
    #[cfg(unix)]
    {
        i64::from(nix::unistd::geteuid().as_raw())
    }
    #[cfg(not(unix))]
    {
        -1
    }
}

/// Go `os.Chown(path, uid, gid)`. 음수는 바꾸지 않는다.
pub(crate) fn chown(path: &Path, uid: i64, gid: i64) -> io::Result<()> {
    #[cfg(unix)]
    {
        use nix::unistd::{Gid, Uid};
        let u = u32::try_from(uid).ok().map(Uid::from_raw);
        let g = u32::try_from(gid).ok().map(Gid::from_raw);
        nix::unistd::chown(path, u, g).map_err(|e| {
            dm_gocompat::oserr::path_error("chown", &path.to_string_lossy(), io::Error::from(e))
        })
    }
    #[cfg(not(unix))]
    {
        let _ = (path, uid, gid);
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }
}
