//! /api/git/{ignore,file-head} — 파일 대상 동작 (GIT_ACTIONS_SRS §3.6 FR-GIT-273·274).
//! Go `handlers_git_ignore.go`.
//!
//! ignore 는 git 을 돌리지 않는 파일 쓰기다 — 경로를 저장소 안으로 가두는 것을 서버가 한다.
//! file-head 는 diff 의 original 쪽(`HEAD:<path>`)을 그대로 읽는다.

use std::io;

use dm_gocompat::filepath;
use dm_gocompat::oserr::{self, go_error_string, path_error};
use dm_shared_httpresp::Response;
use dm_webserver_apierr as apierr;
use dm_webserver_domain_git_query as query;
use dm_webserver_domain_git_write::{self as write, IgnoreResult};
use http::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::GitServer;
use crate::reply::{
    WErr, git_err_json, git_error, git_error_code, git_fail, git_json, git_tail, obj,
};
use crate::req::Req;

/// HEAD 의 내용을 편집기 탭이 열 수 있는 파일로 놓는 자리다. 워킹 트리에는 쓰지 않는다.
const HEAD_TEMP_DIR: &str = "dongminal-git-head";
const HEAD_DIR_PERM: u32 = 0o700;
const HEAD_READ_ONLY_PERM: u32 = 0o444;
const HEAD_FILE_PERM: u32 = 0o600;
const HEAD_HASH_LEN: usize = 12;

#[derive(Default, Deserialize)]
#[serde(default, rename = "gitapi.gitIgnoreReq")]
struct IgnoreReq {
    repo: String,
    paths: Option<Vec<String>>,
}

/// 식별자는 (리포, 경로) 다 — stale 가드의 서버측 절반이다.
#[derive(Serialize)]
struct HeadFileRequested<'a> {
    repo: &'a str,
    path: &'a str,
}

#[derive(Serialize)]
struct HeadFileResponse<'a> {
    requested: HeadFileRequested<'a>,
    repo: &'a str,
    path: &'a str,
    kind: &'a str,
    size: i64,
    /// 편집기 탭이 열 절대경로다.
    #[serde(rename = "openPath")]
    open_path: &'a str,
}

/// 왜 열 수 없는지다 — diff 뷰어가 같은 사유로 본문 대신 안내를 보이는 것과 같은 판정이다.
fn head_not_text_message(kind: &str) -> &'static str {
    match kind {
        query::DIFF_KIND_ABSENT => "HEAD 에 그 경로가 없다",
        query::DIFF_KIND_BINARY => "바이너리 파일이다",
        query::DIFF_KIND_LFS => "LFS 포인터다 — 내용은 원격에 있다",
        query::DIFF_KIND_TOO_LARGE => "상한을 넘는 파일이다",
        _ => "텍스트가 아니다",
    }
}

/// Go `os.TempDir()` — 유닉스는 `$TMPDIR`(비면 `/tmp`)다.
fn os_temp_dir() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

/// 열린 파일의 권한을 바꾼다 — 경로를 다시 따라가지 않는다.
fn set_file_mode(f: &std::fs::File, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        // Go 의 Windows chmod 는 쓰기 비트로 읽기 전용 속성만 바꾼다.
        let mut perm = f.metadata()?.permissions();
        perm.set_readonly(mode & 0o200 == 0);
        f.set_permissions(perm)
    }
}

/// 공유 임시 디렉터리 아래의 자리가 내 것인가다 (FR-RSP-6). 다른 사용자가 미리 만들었거나 심링크로
/// 바꿔 둔 자리면 그 안에 쓰지 않는다 — 쓰기·chmod 가 남의 파일을 따라간다.
#[cfg(unix)]
fn check_private_dir(p: &str) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let md = std::fs::symlink_metadata(p)?;
    let mine = md.uid() == nix::unistd::geteuid().as_raw();
    if !md.file_type().is_dir() || !mine || md.mode() & 0o022 != 0 {
        return Err(io::Error::from_raw_os_error(
            nix::errno::Errno::EPERM as i32,
        ));
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_private_dir(_p: &str) -> io::Result<()> {
    Ok(())
}

/// 새로 쓸 파일을 연다. 끝 성분이 심링크면 따라가지 않고 실패한다.
fn open_head_file(p: &str, mode: u32) -> io::Result<std::fs::File> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(mode)
            .custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits());
    }
    #[cfg(not(unix))]
    let _ = mode;
    o.open(p)
}

/// HEAD 의 내용을 저장소 밖의 정해진 자리에 놓는다. 경로가 결정적이다 — 같은 파일을 다시 열면
/// 같은 경로가 되어 편집기가 이미 열린 탭을 찾는다. `rel` 은 `diff_content_of` 가 검증한
/// 저장소 상대경로다.
fn write_head_temp(root: &str, rel: &str, content: &str) -> io::Result<String> {
    use std::io::Write;
    let sum = hex::encode(Sha256::digest(root.as_bytes()));
    let top = filepath::join(&[os_temp_dir().as_str(), HEAD_TEMP_DIR]);
    let base = filepath::join(&[top.as_str(), &sum[..HEAD_HASH_LEN]]);
    let abs = filepath::join(&[base.as_str(), &filepath::from_slash(rel)]);
    let dir = filepath::dir(&abs);
    oserr::mkdir_all(&dir, HEAD_DIR_PERM)?;
    check_private_dir(&top).map_err(|e| path_error("mkdir", &top, e))?;
    // 이미 있으면 쓰기 권한을 먼저 되돌린다 — 아래에서 읽기 전용으로 둔다. 심링크는 따라가지 않는다.
    match std::fs::symlink_metadata(&abs) {
        Ok(md) if md.file_type().is_file() => {
            let mut perm = md.permissions();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                perm.set_mode(HEAD_FILE_PERM);
            }
            #[cfg(not(unix))]
            #[expect(
                clippy::permissions_set_readonly_false,
                reason = "Go os.Chmod 의 Windows 갈래처럼 읽기 전용만 푼다"
            )]
            perm.set_readonly(false);
            std::fs::set_permissions(&abs, perm).map_err(|e| path_error("chmod", &abs, e))?;
        }
        _ => {}
    }
    let mut f = open_head_file(&abs, HEAD_FILE_PERM).map_err(|e| path_error("open", &abs, e))?;
    f.write_all(content.as_bytes())
        .map_err(|e| path_error("write", &abs, e))?;
    // 읽기 전용으로 둔다 — 여기서 저장하면 편집이 임시 파일로 조용히 사라진다 (FR-GIT-274).
    set_file_mode(&f, HEAD_READ_ONLY_PERM).map_err(|e| path_error("chmod", &abs, e))?;
    Ok(abs)
}

impl GitServer {
    /// POST /api/git/ignore — 경로를 저장소 루트의 `.gitignore` 에 덧붙인다 (FR-GIT-273). git 을
    /// 돌리지 않아도 status 는 바뀌므로 실행 후 status 를 함께 준다 (FR-GIT-71).
    pub(crate) async fn api_git_ignore_add(&self, r: &mut Req) -> Response {
        let (mut t, req) = self.begin_write::<IgnoreReq>(r).await;
        t.resolve(&req.repo).await;
        if t.stop() {
            return t.finish();
        }
        let paths = req.paths.unwrap_or_default();
        // 하나라도 이탈이면 아무것도 쓰지 않는다. 코드는 호출 문맥이 정한다.
        for p in &paths {
            if let Err(e) = write::ignore_pattern(&t.root, p) {
                t.reject_with(
                    StatusCode::BAD_REQUEST,
                    apierr::CODE_IGNORE_PATH,
                    &git_tail(&e.to_string()),
                );
                return t.finish();
            }
        }
        let mut res = IgnoreResult::default();
        let out = &mut res;
        let root = t.root.clone();
        t.apply(|_ctx| async move {
            *out = write::ignore_add(&root, &paths)?;
            Ok::<(), WErr>(())
        })
        .await;
        // added 와 skipped 를 나눠 싣는다.
        t.ok(Some(
            &obj! {"file" => res.file, "added" => res.added, "skipped" => res.skipped},
        ));
        t.finish()
    }

    /// GET /api/git/file-head?repo=&path= — `HEAD:<path>` 의 내용을 편집기가 열 수 있는 파일로
    /// 놓고 그 경로를 준다 (FR-GIT-274). 저장소 밖에 놓는다.
    pub(crate) async fn api_git_file_head(&self, r: &mut Req) -> Response {
        let (git, root, requested) = match self.git_repo_param(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let p = r.q("path");
        let req = HeadFileRequested {
            repo: &requested,
            path: &p,
        };
        let diffs = self.diff_git(&git);
        let dc =
            match query::diff_content_of(&diffs, &r.ctx, &root, query::AXIS_WORKTREE_HEAD, &p, "")
                .await
            {
                Ok(dc) => dc,
                Err(e) => return git_error(&e),
            };
        let side = &dc.original;
        if side.kind != query::DIFF_KIND_TEXT {
            // 사유를 코드로 준다 — 빈 편집기를 열면 사용자는 파일이 비었다고 읽는다.
            return git_err_json(
                StatusCode::CONFLICT,
                apierr::CODE_NOT_TEXT,
                &obj! {
                    "error" => apierr::CODE_NOT_TEXT,
                    "message" => head_not_text_message(&side.kind),
                    "requested" => req, "repo" => root, "path" => dc.path,
                    "kind" => side.kind, "size" => side.size,
                },
            );
        }
        let abs = match write_head_temp(&root, &dc.path, &side.content) {
            Ok(abs) => abs,
            Err(e) => {
                let (code, name) = git_error_code(&e);
                return git_fail(code, name, &git_tail(&go_error_string(&e)));
            }
        };
        git_json(
            StatusCode::OK,
            &HeadFileResponse {
                requested: req,
                repo: &root,
                path: &dc.path,
                kind: &side.kind,
                size: side.size,
                open_path: &abs,
            },
        )
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    // FR-RSP-6: 자리를 다시 쓰면 같은 경로·읽기 전용이고, 끝 성분이 심링크면 따라가지 않는다.
    #[test]
    fn head_temp_rewrites_and_refuses_symlink() {
        let root = format!("/head-temp-test/{}", std::process::id());
        let a = write_head_temp(&root, "d/a.txt", "one").unwrap();
        let b = write_head_temp(&root, "d/a.txt", "two").unwrap();
        assert_eq!(a, b);
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "two");
        let mode = std::fs::metadata(&a).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, HEAD_READ_ONLY_PERM);

        let victim = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(victim.path(), "keep").unwrap();
        let link = write_head_temp(&root, "d/link.txt", "x").unwrap();
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(victim.path(), &link).unwrap();
        let err = write_head_temp(&root, "d/link.txt", "evil").unwrap_err();
        assert!(go_error_string(&err).starts_with("open "), "{err}");
        assert_eq!(std::fs::read_to_string(victim.path()).unwrap(), "keep");

        let dir = filepath::dir(&filepath::dir(&a));
        let _ = std::fs::set_permissions(&a, std::fs::Permissions::from_mode(0o600));
        let _ = std::fs::remove_dir_all(dir);
    }

    // FR-RDF-9: 조상이 파일이면 Go os.MkdirAll 처럼 막힌 그 칸의 경로로 not a directory 를 낸다.
    #[test]
    fn head_temp_mkdir_error_matches_go() {
        let root = format!("/head-temp-mkdir-test/{}", std::process::id());
        let a = write_head_temp(&root, "a.txt", "one").unwrap();
        let base = filepath::dir(&a);
        let blocker = filepath::join(&[base.as_str(), "f"]);
        std::fs::write(&blocker, "x").unwrap();
        let err = write_head_temp(&root, "f/x/a.txt", "two").unwrap_err();
        assert_eq!(
            go_error_string(&err),
            format!("mkdir {blocker}: not a directory")
        );
        let _ = std::fs::set_permissions(&a, std::fs::Permissions::from_mode(0o600));
        let _ = std::fs::remove_dir_all(base);
    }
}
