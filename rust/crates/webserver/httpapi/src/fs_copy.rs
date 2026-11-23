//! 탐색기의 복사·복제 (Go `handlers_fs_copy.go`, FR-WBR-60~66). 루트를 둘 받는 유일한 fs 종단이다.
//! 먼저 세고, 넘으면 시작하지 않는다. 이름이 겹치면 `이름 copy`·`이름 copy 2` 로 비켜 간다.

use std::fs::Metadata;
use std::io::ErrorKind;

use dm_gocompat::filepath;
use dm_shared_httpresp::Response;
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::fs::{
    FS_ERR_BAD_REQUEST, FS_ERR_EXISTS, FsError, fs_decode, fs_fail, fs_fail_err, fs_from_io,
    fs_resolve_existing, fs_resolve_target,
};
use crate::fs_actions::{fs_into_self_answer, fs_reject_answer, fs_too_many};
use crate::fs_mutate::{create_excl, fs_count, mkdir};
use crate::httperr::write_json;
use crate::req::Req;

/// 비켜 갈 이름을 찾는 횟수의 상한이다.
const FS_COPY_NAME_MAX: usize = 1000;

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fsCopyReq")]
struct FsCopyReq {
    #[serde(rename = "srcRoot")]
    src_root: String,
    src: String,
    #[serde(rename = "dstRoot")]
    dst_root: String,
    #[serde(rename = "dstDir")]
    dst_dir: String,
}

#[derive(Serialize)]
struct CopyResp {
    ok: bool,
    path: String,
}

/// 복사할 수 없는 종류(장치·소켓 등)다 (Go `errFSCopySkip`).
enum CopyErr {
    Skip,
    Io(std::io::Error),
}

impl From<std::io::Error> for CopyErr {
    fn from(e: std::io::Error) -> Self {
        CopyErr::Io(e)
    }
}

impl Server {
    /// POST /api/fs/copy (FR-WBR-60).
    pub(crate) async fn api_fs_copy(&self, r: &mut Req) -> Response {
        let req: FsCopyReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let src_root = match self.fs_root(&req.src_root) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let dst_root = match self.fs_root(&req.dst_root) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let src = match fs_resolve_target(&src_root, &req.src) {
            Ok(v) => v,
            Err(e) => return fs_fail_err(&e),
        };
        let st = match std::fs::symlink_metadata(&src) {
            Ok(st) => st,
            Err(e) => return fs_fail_err(&fs_from_io(&e)),
        };
        let dst_dir = match fs_resolve_existing(&dst_root, &req.dst_dir) {
            Ok(v) => v,
            Err(e) => return fs_fail_err(&e),
        };
        if !std::fs::metadata(&dst_dir).is_ok_and(|m| m.is_dir()) {
            return fs_fail(FS_ERR_BAD_REQUEST, "대상이 디렉터리가 아니다");
        }
        let a = fs_into_self_answer(&src, &dst_dir, st.is_dir());
        if !a.ok {
            return fs_reject_answer(&a);
        }
        let max = self.limits.fs_copy;
        let ops = self.fs.ops.clone();
        let res = tokio::task::spawn_blocking(move || {
            // 세기는 잠금 밖이다 — 큰 트리를 세는 동안 다른 조작이 줄 서지 않는다.
            match fs_count(&src, max) {
                Err(e) => return fs_fail_err(&e),
                Ok(n) if n > max => return fs_reject_answer(&fs_too_many(max)),
                Ok(_) => {}
            }
            let _g = ops.lock().unwrap_or_else(|e| e.into_inner());
            let st = match std::fs::symlink_metadata(&src) {
                Ok(st) => st,
                Err(e) => return fs_fail_err(&fs_from_io(&e)),
            };
            let target = match fs_copy_create(&dst_dir, &filepath::base(&src), &src, &st) {
                Ok(t) => t,
                Err(e) => return fs_fail_err(&e),
            };
            if st.is_dir()
                && let Err(e) = fs_copy_dir_into(&src, &target, &st)
            {
                let _ = std::fs::remove_dir_all(&target);
                return fs_fail_err(&fs_from_io(&e));
            }
            write_json(&CopyResp {
                ok: true,
                path: target,
            })
        })
        .await;
        match res {
            Ok(res) => res,
            Err(e) => std::panic::resume_unwind(e.into_panic()),
        }
    }
}

/// Go `fsCopyCreate`: 첫 조각을 원자적으로 만들며 쓸 수 있는 이름을 찾는다.
fn fs_copy_create(dir: &str, base: &str, src: &str, st: &Metadata) -> Result<String, FsError> {
    for i in 0..=FS_COPY_NAME_MAX {
        let name = if i == 0 {
            base.to_owned()
        } else {
            fs_copy_name(base, i)
        };
        let p = filepath::join(&[dir, name.as_str()]);
        match fs_copy_node(src, &p, st) {
            Ok(()) => return Ok(p),
            Err(CopyErr::Skip) => {
                return Err(FsError::new(FS_ERR_BAD_REQUEST, "복사할 수 없는 종류다"));
            }
            Err(CopyErr::Io(e)) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(CopyErr::Io(e)) => return Err(fs_from_io(&e)),
        }
    }
    Err(FsError::new(FS_ERR_EXISTS, "쓸 수 있는 이름을 찾지 못했다"))
}

/// Go `fsCopyName`: `a.txt` → `a copy.txt`, `a copy 2.txt`. 점으로 시작하는 이름은 통째로 줄기다.
pub(crate) fn fs_copy_name(base: &str, n: usize) -> String {
    let (stem, ext) = match base.rfind('.') {
        Some(i) if i > 0 => (&base[..i], &base[i..]),
        _ => (base, ""),
    };
    if n == 1 {
        return format!("{stem} copy{ext}");
    }
    format!("{stem} copy {n}{ext}")
}

/// Go `Mode().Perm()`.
fn perm(st: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        st.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        if st.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}

fn chmod(p: &str, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let mut pm = std::fs::metadata(p)?.permissions();
        pm.set_readonly(mode & 0o200 == 0);
        std::fs::set_permissions(p, pm)
    }
}

/// Go `fsCopyNode`: 링크는 링크로, 디렉터리는 빈 디렉터리로, 일반 파일은 내용째 만든다.
fn fs_copy_node(src: &str, dst: &str, st: &Metadata) -> Result<(), CopyErr> {
    let ft = st.file_type();
    if ft.is_symlink() {
        let t = std::fs::read_link(src)?;
        symlink(&t, dst)?;
        return Ok(());
    }
    if ft.is_dir() {
        mkdir(dst, perm(st) | 0o700)?;
        return Ok(());
    }
    if ft.is_file() {
        fs_copy_file(src, dst, st)?;
        return Ok(());
    }
    Err(CopyErr::Skip)
}

#[cfg(unix)]
fn symlink(t: &std::path::Path, dst: &str) -> std::io::Result<()> {
    std::os::unix::fs::symlink(t, dst)
}

#[cfg(windows)]
fn symlink(t: &std::path::Path, dst: &str) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(t, dst)
}

fn fs_copy_file(src: &str, dst: &str, st: &Metadata) -> std::io::Result<()> {
    let mut input = std::fs::File::open(src)?;
    let mut out = create_excl(dst, perm(st))?;
    std::io::copy(&mut input, &mut out)?;
    drop(out);
    chmod(dst, perm(st))
}

/// Go `fsCopyDirInto`: 복사할 수 없는 종류는 건너뛴다. 끝에 디렉터리 권한을 원본과 맞춘다.
fn fs_copy_dir_into(src: &str, dst: &str, st: &Metadata) -> std::io::Result<()> {
    let mut ents: Vec<_> = std::fs::read_dir(src)?.collect::<Result<_, _>>()?;
    ents.sort_by_key(|e| e.file_name());
    for e in ents {
        let ci = e.metadata()?;
        let name = e.file_name().to_string_lossy().into_owned();
        let s2 = filepath::join(&[src, name.as_str()]);
        let d2 = filepath::join(&[dst, name.as_str()]);
        match fs_copy_node(&s2, &d2, &ci) {
            Ok(()) => {}
            Err(CopyErr::Skip) => continue,
            Err(CopyErr::Io(e)) => return Err(e),
        }
        if ci.is_dir() {
            fs_copy_dir_into(&s2, &d2, &ci)?;
        }
    }
    chmod(dst, perm(st))
}
