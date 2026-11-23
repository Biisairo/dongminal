//! 탐색기의 쓰기 조작 (Go `handlers_fs_mutate.go` 와 `handlers_fs.go` 의 `apiFSCreate`,
//! EDITOR_TAB_SRS FR-EDT-109·112·115·118). 조작은 `fs.ops` 로 우리끼리 직렬화한다 — Stat 후
//! 생성·이름 바꾸기 사이의 경합은 `O_EXCL`·`link` 로 닫는다.

use std::fs::Metadata;
use std::io::ErrorKind;

use dm_gocompat::filepath;
use dm_shared_httpresp::Response;
use serde::Deserialize;

use crate::Server;
use crate::fs::{FS_ERR_EXISTS, FsError, fs_decode, fs_fail_err, fs_from_io, fs_ok, fs_target_in};
use crate::fs_actions::{fs_err_answer, fs_into_self_answer, fs_name_answer, fs_reject_answer};
use crate::req::Req;

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fsCreateReq")]
struct FsCreateReq {
    root: String,
    path: String,
    dir: bool,
    parent: String,
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fsRenameReq")]
struct FsRenameReq {
    root: String,
    from: String,
    to: String,
    #[serde(rename = "srcRoot")]
    src_root: String,
    #[serde(rename = "dstRoot")]
    dst_root: String,
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(default, rename = "httpapi.fsDeleteReq")]
struct FsDeleteReq {
    root: String,
    path: String,
}

fn exists_err() -> FsError {
    FsError::new(FS_ERR_EXISTS, "대상에 같은 이름이 이미 있다")
}

/// Go `os.IsExist`: EEXIST 와 ENOTEMPTY.
fn is_exist(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        ErrorKind::AlreadyExists | ErrorKind::DirectoryNotEmpty
    )
}

impl Server {
    /// POST /api/fs/create (FR-EDT-109·115). `parent`·`name` 이 있으면 `path` 대신 쓴다 (F-j).
    pub(crate) async fn api_fs_create(&self, r: &mut Req) -> Response {
        let req: FsCreateReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let mut path = req.path.clone();
        if !req.name.is_empty() || !req.parent.is_empty() {
            let a = fs_name_answer(&req.name);
            if !a.ok {
                return fs_reject_answer(&a);
            }
            path = filepath::join(&[req.parent.as_str(), req.name.trim()]);
        }
        let (_, target) = match self.fs_root_target(&req.root, &path) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let res = {
            let _g = self.fs.ops.lock().unwrap_or_else(|e| e.into_inner());
            if req.dir {
                mkdir(&target, 0o755)
            } else {
                create_excl(&target, 0o644).map(|_| ())
            }
        };
        match res {
            Ok(()) => fs_ok(),
            Err(e) => fs_fail_err(&fs_from_io(&e)),
        }
    }

    /// POST /api/fs/rename — 같은 루트의 이름 바꾸기와 두 루트 사이의 옮기기 (FR-EDT-115, FR-WBR-60).
    pub(crate) async fn api_fs_rename(&self, r: &mut Req) -> Response {
        let req: FsRenameReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let src_root = if req.src_root.is_empty() {
            &req.root
        } else {
            &req.src_root
        };
        let dst_root = if req.dst_root.is_empty() {
            &req.root
        } else {
            &req.dst_root
        };
        let (from_root, from) = match self.fs_root_target(src_root, &req.from) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let to = match self.fs_rename_to(&req, &from_root, &from, dst_root) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let a = self.fs_move_answer(&from_root, &from);
        if !a.ok {
            return fs_reject_answer(&a);
        }
        let st = match std::fs::symlink_metadata(&from) {
            Ok(st) => st,
            Err(e) => return fs_fail_err(&fs_from_io(&e)),
        };
        let a = fs_into_self_answer(&from, &filepath::dir(&to), st.is_dir());
        if !a.ok {
            return fs_reject_answer(&a);
        }
        match self.fs_rename_no_replace(&from, &to) {
            Ok(()) => fs_ok(),
            Err(e) => fs_fail_err(&e),
        }
    }

    fn fs_rename_to(
        &self,
        req: &FsRenameReq,
        from_root: &str,
        from: &str,
        dst_root: &str,
    ) -> Result<String, Response> {
        if req.name.is_empty() {
            return self.fs_root_target(dst_root, &req.to).map(|(_, t)| t);
        }
        let a = fs_name_answer(&req.name);
        if !a.ok {
            return Err(fs_reject_answer(&a));
        }
        fs_target_in(
            from_root,
            &filepath::join(&[filepath::dir(from).as_str(), req.name.trim()]),
        )
    }

    /// Go `fsRenameNoReplace`: 대상이 있으면 덮지 않는다. 대소문자만 바꾸는 이름 바꾸기는 예외다.
    fn fs_rename_no_replace(&self, from: &str, to: &str) -> Result<(), FsError> {
        let _g = self.fs.ops.lock().unwrap_or_else(|e| e.into_inner());
        let st = std::fs::symlink_metadata(from).map_err(|e| fs_from_io(&e))?;
        if let Ok(tst) = std::fs::symlink_metadata(to) {
            if !case_only_rename(from, to, &st, &tst) {
                return Err(exists_err());
            }
            return std::fs::rename(from, to).map_err(|e| fs_from_io(&e));
        }
        if st.file_type().is_file() {
            match std::fs::hard_link(from, to) {
                Ok(()) => {
                    if let Err(e) = std::fs::remove_file(from) {
                        // 되돌리기 — 이름 둘이 남는 것이 최악이다.
                        let _ = std::fs::remove_file(to);
                        return Err(fs_from_io(&e));
                    }
                    return Ok(());
                }
                Err(e) if is_exist(&e) => return Err(exists_err()),
                Err(_) => {}
            }
        }
        match std::fs::rename(from, to) {
            Ok(()) => Ok(()),
            Err(e) if is_exist(&e) => Err(exists_err()),
            Err(e) => Err(fs_from_io(&e)),
        }
    }

    /// POST /api/fs/delete (FR-EDT-118). 먼저 세고, 넘으면 아무것도 지우지 않는다.
    pub(crate) async fn api_fs_delete(&self, r: &mut Req) -> Response {
        let req: FsDeleteReq = match fs_decode(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let (root, target) = match self.fs_root_target(&req.root, &req.path) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let (a, _) =
            self.fs_delete_answer(&root, std::slice::from_ref(&target), self.limits.fs_delete);
        if !a.ok {
            return fs_reject_answer(&a);
        }
        let ops = self.fs.ops.clone();
        let res = tokio::task::spawn_blocking(move || {
            let _g = ops.lock().unwrap_or_else(|e| e.into_inner());
            let st = match std::fs::symlink_metadata(&target) {
                Ok(st) => st,
                Err(e) => return fs_reject_answer(&fs_err_answer(&fs_from_io(&e))),
            };
            match remove_all(&target, &st) {
                Ok(()) => fs_ok(),
                Err(e) => fs_fail_err(&fs_from_io(&e)),
            }
        })
        .await;
        match res {
            Ok(res) => res,
            Err(e) => std::panic::resume_unwind(e.into_panic()),
        }
    }
}

/// Go `os.RemoveAll`: 링크는 따라가지 않는다.
fn remove_all(p: &str, st: &Metadata) -> std::io::Result<()> {
    if st.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    }
}

/// Go `caseOnlyRename`: 같은 디렉터리에서 대소문자만 다르고 같은 파일인가.
fn case_only_rename(from: &str, to: &str, fst: &Metadata, tst: &Metadata) -> bool {
    if filepath::dir(from) != filepath::dir(to) {
        return false;
    }
    let (a, b) = (filepath::base(from), filepath::base(to));
    a != b && go_equal_fold(&a, &b) && same_file(from, to, fst, tst)
}

/// Go `strings.EqualFold` (단순 대소문자 접기).
fn go_equal_fold(a: &str, b: &str) -> bool {
    let fold = |c: char| c.to_lowercase().next().unwrap_or(c);
    a.chars().count() == b.chars().count()
        && a.chars().zip(b.chars()).all(|(x, y)| fold(x) == fold(y))
}

#[cfg(unix)]
fn same_file(_: &str, _: &str, a: &Metadata, b: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    a.dev() == b.dev() && a.ino() == b.ino()
}

#[cfg(not(unix))]
fn same_file(a: &str, b: &str, _: &Metadata, _: &Metadata) -> bool {
    matches!((std::fs::canonicalize(a), std::fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
}

/// Go `os.Mkdir(p, perm)`.
pub(crate) fn mkdir(p: &str, perm: u32) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(perm);
    }
    #[cfg(not(unix))]
    let _ = perm;
    b.create(p)
}

/// Go `os.OpenFile(p, O_CREATE|O_EXCL|O_WRONLY, perm)`.
pub(crate) fn create_excl(p: &str, perm: u32) -> std::io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(perm);
    }
    #[cfg(not(unix))]
    let _ = perm;
    o.open(p)
}

/// Go `fsCountEntries`: 대상 자신을 포함한 항목 수. `max` 를 넘는 순간 멈춘다 — 넘은 것은
/// `n > max` 로 알린다.
pub(crate) fn fs_count(target: &str, max: usize) -> Result<usize, FsError> {
    let mut n = 0;
    match walk(std::path::Path::new(target), None, max, &mut n) {
        Ok(()) | Err(Walk::Over) => Ok(n),
        Err(Walk::Io(e)) => Err(fs_from_io(&e)),
    }
}

enum Walk {
    Over,
    Io(std::io::Error),
}

/// Go `filepath.WalkDir`: 링크를 따라가지 않고, 디렉터리를 센 뒤에 그 안을 읽는다.
fn walk(p: &std::path::Path, is_dir: Option<bool>, max: usize, n: &mut usize) -> Result<(), Walk> {
    let is_dir = match is_dir {
        Some(d) => d,
        None => std::fs::symlink_metadata(p).map_err(Walk::Io)?.is_dir(),
    };
    *n += 1;
    if *n > max {
        return Err(Walk::Over);
    }
    if !is_dir {
        return Ok(());
    }
    let mut ents: Vec<_> = std::fs::read_dir(p)
        .map_err(Walk::Io)?
        .collect::<Result<_, _>>()
        .map_err(Walk::Io)?;
    ents.sort_by_key(|e| e.file_name());
    for e in ents {
        let d = e.file_type().map_err(Walk::Io)?.is_dir();
        walk(&e.path(), Some(d), max, n)?;
    }
    Ok(())
}
