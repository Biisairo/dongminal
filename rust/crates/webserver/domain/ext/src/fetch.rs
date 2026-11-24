//! 아카이브 조달: 받고 → 해시를 대조하고 → 옆에 풀고 → 통째로 갈아 끼운다 (FR-EXT-11·15·24·39,
//! FR-ATF-20~25). 실패는 아무것도 남기지 않는다.

use std::fs::File;
use std::future::Future;
use std::io::{self, Read, Write};
use std::pin::Pin;
use std::sync::OnceLock;

use otter_gocompat::filepath;
use otter_gocompat::oserr::link_error;
use otter_gocompat::path;
use otter_gocompat::strconv::quote;
use sha2::{Digest, Sha256};

use crate::ctx::Ctx;
use crate::error::{Error, Sentinel, errorf};
use crate::goos;
use crate::manifest::{MANIFEST_NAME, Target};

/// 아카이브 하나의 크기 상한 (OPTIMIZE_REFACTOR_SRS FR-OPT-1-11).
pub const MAX_ARCHIVE_BYTES: i64 = 1 << 30;

/// 해제 총량 상한은 [`MAX_ARCHIVE_BYTES`] 의 이 배수다 (FR-ATF-25).
pub const EXTRACT_RATIO: i64 = 4;

/// 새 설치를 풀어 두는 옆 자리의 꼬리. 팩 id 는 이것으로 끝날 수 없다 (FR-ATF-22).
pub(crate) const STAGING_SUFFIX: &str = ".new";

// 갈아 끼우는 동안 옛 설치를 비켜 두는 자리 (FR-ATF-23).
const ASIDE_PATTERN: &str = ".old-*";
const ASIDE_NAME: &str = "old";

/// 받은 것을 잠깐 두는 임시 파일의 이름 꼴.
const TEMP_PATTERN: &str = "otter-ext-*";

const DIR_PERM: u32 = 0o755;
const FILE_PERM: u32 = 0o644;
const EXE_PERM: u32 = 0o755;

/// Go net/http 의 기본 User-Agent. 받는 쪽이 보는 값을 Go 와 같게 한다.
const USER_AGENT: &str = "Go-http-client/1.1";

/// 박스에 담은 future.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// URL 하나를 받아 `w` 에 쓴다. **주입점이다** (§2.5 ③) — 검사는 네트워크에 나가지 않는다.
pub trait Fetch: Send + Sync {
    fn fetch<'a>(
        &'a self,
        ctx: &'a Ctx,
        url: &'a str,
        w: &'a mut (dyn Write + Send),
    ) -> BoxFuture<'a, io::Result<()>>;
}

/// 실제 네트워크 (Go `HTTPFetch`). 200 이 아니면 `<url>: <상태>` 다.
pub struct HttpFetch;

fn http_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            // TLS 공급자는 rustls 의 ring 이다. 이미 정해져 있으면 그것을 쓴다.
            let _ = rustls::crypto::ring::default_provider().install_default();
            reqwest::Client::builder()
                .user_agent(USER_AGENT)
                .build()
                .map_err(|e| innermost(&e))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// 오류 사슬의 가장 안쪽 문구. Go `*url.Error` 의 꼬리에 가깝다.
fn innermost(e: &(dyn std::error::Error + 'static)) -> String {
    let mut cur = e;
    while let Some(next) = cur.source() {
        cur = next;
    }
    cur.to_string()
}

impl Fetch for HttpFetch {
    fn fetch<'a>(
        &'a self,
        ctx: &'a Ctx,
        url: &'a str,
        w: &'a mut (dyn Write + Send),
    ) -> BoxFuture<'a, io::Result<()>> {
        Box::pin(async move {
            let url_err = |msg: String| io::Error::other(format!("Get {}: {msg}", quote(url)));
            let client = http_client().map_err(url_err)?;
            let resp = tokio::select! {
                r = client.get(url).send() => r.map_err(|e| url_err(innermost(&e)))?,
                e = ctx.done() => return Err(url_err(e.to_string())),
            };
            let status = resp.status();
            if status != reqwest::StatusCode::OK {
                return Err(io::Error::other(format!(
                    "{url}: {} {}",
                    status.as_u16(),
                    status.canonical_reason().unwrap_or("")
                )));
            }
            let mut resp = resp;
            loop {
                let chunk = tokio::select! {
                    c = resp.chunk() => c.map_err(|e| io::Error::other(innermost(&e)))?,
                    e = ctx.done() => return Err(io::Error::other(e.to_string())),
                };
                match chunk {
                    Some(b) => w.write_all(&b)?,
                    None => return Ok(()),
                }
            }
        })
    }
}

/// 상한을 넘는 쓰기를 거절한다. 넘은 것을 해시 대조 전에 가린다.
struct CapWriter<'a> {
    file: &'a mut File,
    hash: &'a mut Sha256,
    left: i64,
}

impl Write for CapWriter<'_> {
    fn write(&mut self, p: &[u8]) -> io::Result<usize> {
        if p.len() as i64 > self.left {
            return Err(Sentinel::ArchiveTooLarge.io());
        }
        self.left -= p.len() as i64;
        self.file.write_all(p)?;
        self.hash.update(p);
        Ok(p.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// 검사가 바꾸는 값들. 실제 조달은 [`Opts::default`] 다.
#[derive(Clone, Copy)]
pub(crate) struct Opts {
    pub(crate) max_archive: i64,
    /// 디렉터리 옮기기. 검사가 실패를 끼워 넣는 자리다.
    pub(crate) rename: fn(&str, &str) -> io::Result<()>,
}

impl Default for Opts {
    fn default() -> Self {
        Self {
            max_archive: MAX_ARCHIVE_BYTES,
            rename: goos::rename,
        }
    }
}

/// 지정한 파일을 Drop 에서 지운다 (Go `defer os.Remove`).
struct RemoveOnDrop(String);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// 타깃 하나를 받아 `dest` 에 푼다. 받은 것은 `tmp_dir`(격리 칸의 cache)에 잠깐 둔다 (FR-ATF-24).
pub async fn fetch_archive(
    ctx: &Ctx,
    fetch: &dyn Fetch,
    t: &Target,
    dest: &str,
    tmp_dir: &str,
) -> Result<(), Error> {
    fetch_archive_with(ctx, fetch, t, dest, tmp_dir, Opts::default()).await
}

pub(crate) async fn fetch_archive_with(
    ctx: &Ctx,
    fetch: &dyn Fetch,
    t: &Target,
    dest: &str,
    tmp_dir: &str,
    opts: Opts,
) -> Result<(), Error> {
    t.validate()?;
    goos::mkdir_all(tmp_dir, DIR_PERM)
        .map_err(|e| Error::from(e).wrap("임시 자리를 만들지 못했습니다"))?;
    let (mut file, tmp_name) = goos::create_temp(tmp_dir, TEMP_PATTERN)
        .map_err(|e| Error::from(e).wrap("임시 파일을 만들지 못했습니다"))?;
    let _cleanup = RemoveOnDrop(tmp_name.clone());

    let mut hash = Sha256::new();
    let res = {
        let mut w = CapWriter {
            file: &mut file,
            hash: &mut hash,
            left: opts.max_archive,
        };
        fetch.fetch(ctx, &t.url, &mut w).await
    };
    drop(file);
    if let Err(e) = res {
        return Err(Error::from(e).wrap(format!("{} 를 받지 못했습니다", t.url)));
    }

    // FR-EXT-15: 어긋나면 풀지 않는다.
    let got = hex::encode(hash.finalize());
    if !got.eq_ignore_ascii_case(&t.sha256) {
        return Err(errorf!(
            "받은 것의 sha256 이 선언과 다릅니다 (선언 {}, 실제 {got}) — 풀지 않았습니다",
            t.sha256
        ));
    }

    let (t, dest) = (t.clone(), dest.to_owned());
    tokio::task::spawn_blocking(move || install_blob(&tmp_name, &t, &dest, opts))
        .await
        .unwrap_or_else(|e| Err(Error::new(e.to_string())))
}

/// 받은 것을 옆에 풀고 통째로 갈아 끼운다 — 반쯤 풀린 상태가 보이지 않고 판이 섞이지 않는다.
fn install_blob(blob: &str, t: &Target, dest: &str, opts: Opts) -> Result<(), Error> {
    let staging = format!("{dest}{STAGING_SUFFIX}");
    goos::remove_all(&staging);
    goos::mkdir_all(&staging, DIR_PERM)
        .map_err(|e| Error::from(e).wrap("풀 자리를 만들지 못했습니다"))?;
    let fail = |e: Error| {
        goos::remove_all(&staging);
        Err(e)
    };
    if let Err(e) = place(blob, &staging, t, opts.max_archive * EXTRACT_RATIO) {
        return fail(e);
    }
    // server 팩은 선언과 같은 자리에 받는다 — 갈아 끼울 때 선언을 옮겨 담는다 (FR-ELS-3).
    if let Err(e) = keep_manifest(dest, &staging) {
        return fail(e);
    }
    if let Err(e) = goos::mkdir_all(&filepath::dir(dest), DIR_PERM) {
        return fail(Error::from(e).wrap("자리를 만들지 못했습니다"));
    }
    swap_in(&staging, dest, opts.rename)
}

/// staging 을 dest 자리에 옮겨 넣는다. 옛 설치는 비켜 두고, 성공한 뒤에만 지운다 (FR-ATF-23).
fn swap_in(
    staging: &str,
    dest: &str,
    rename: fn(&str, &str) -> io::Result<()>,
) -> Result<(), Error> {
    let mut aside = None;
    if goos::lexists(dest) {
        let pattern = format!("{}{ASIDE_PATTERN}{STAGING_SUFFIX}", filepath::base(dest));
        let holder = match goos::mkdir_temp(&filepath::dir(dest), &pattern) {
            Ok(h) => h,
            Err(e) => {
                goos::remove_all(staging);
                return Err(Error::from(e).wrap("옛 설치를 비켜 둘 자리를 만들지 못했습니다"));
            }
        };
        let a = filepath::join(&[holder.as_str(), ASIDE_NAME]);
        if let Err(e) = rename(dest, &a) {
            goos::remove_all(&holder);
            goos::remove_all(staging);
            return Err(Error::from(e).wrap("옛 설치를 비켜 두지 못했습니다"));
        }
        aside = Some(a);
    }
    if let Err(e) = rename(staging, dest) {
        goos::remove_all(staging);
        if let Some(a) = &aside {
            if rename(a, dest).is_err() {
                return Err(Error::from(e).wrap(format!(
                    "풀어 둔 것을 옮기지 못했고 옛 설치를 {a} 에 남겼습니다"
                )));
            }
            goos::remove_all(&filepath::dir(a));
        }
        return Err(Error::from(e).wrap("풀어 둔 것을 옮기지 못했습니다"));
    }
    if let Some(a) = &aside {
        goos::remove_all(&filepath::dir(a));
    }
    Ok(())
}

/// dest 의 선언을 staging 으로 옮겨 담는다. 선언이 없으면 아무것도 하지 않는다.
fn keep_manifest(dest: &str, staging: &str) -> Result<(), Error> {
    let mut f = match goos::open(&filepath::join(&[dest, MANIFEST_NAME])) {
        Ok(f) => f,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(Error::from(e).wrap("선언을 읽지 못했습니다")),
    };
    write_file(
        &filepath::join(&[staging, MANIFEST_NAME]),
        &mut f,
        FILE_PERM,
    )
    .map_err(|e| Error::from(e).wrap("선언을 옮기지 못했습니다"))
}

/// raw 이면 `bin` 자리에 그대로 놓고, 아니면 푼다.
fn place(blob: &str, dir: &str, t: &Target, budget: i64) -> Result<(), Error> {
    if !t.raw {
        return extract(blob, dir, t.strip, budget);
    }
    let mut f = goos::open(blob).map_err(|e| Error::from(e).wrap("받은 것을 열지 못했습니다"))?;
    let target = filepath::join(&[dir, filepath::from_slash(&t.bin).as_str()]);
    Ok(write_file(&target, &mut f, EXE_PERM)?)
}

/// 형식은 파일 이름 꼬리나 `PK` 머리로 가른다.
fn extract(archive: &str, dest: &str, strip: i64, budget: i64) -> Result<(), Error> {
    let mut u = Unpacker::new(dest, budget)?;
    if archive.to_lowercase().ends_with(".zip") || is_zip(archive) {
        return extract_zip(archive, &mut u, strip);
    }
    extract_tar_gz(archive, &mut u, strip)
}

/// 엔트리를 격리 칸 하나에 놓는다. 쓰기 전에 **디스크의 실경로**를 본다 (FR-ATF-20).
struct Unpacker {
    dest: String,
    /// dest 의 실경로. 비교의 기준이다.
    real: String,
    /// 해제할 수 있는 남은 바이트 (FR-ATF-25).
    left: i64,
}

impl Unpacker {
    fn new(dest: &str, budget: i64) -> Result<Self, Error> {
        let real = filepath::eval_symlinks(dest)
            .map_err(|e| Error::from(e).wrap("풀 자리를 확인하지 못했습니다"))?;
        Ok(Self {
            dest: dest.to_owned(),
            real,
            left: budget,
        })
    }

    fn inside(&self, real: &str) -> bool {
        match filepath::rel(&self.real, real) {
            Ok(rel) if !filepath::is_abs(&rel) => {
                rel != ".." && !rel.starts_with(&format!("..{}", filepath::SEPARATOR))
            }
            _ => false,
        }
    }

    /// dir 을 만든다. 이미 있는 가장 가까운 조상의 실경로가 칸 안일 때만이다.
    fn mkdir(&self, dir: &str) -> Result<(), Error> {
        let mut p = dir.to_owned();
        loop {
            if goos::lexists(&p) {
                break;
            }
            let parent = filepath::dir(&p);
            if parent == p {
                break;
            }
            p = parent;
        }
        let real = filepath::eval_symlinks(&p)
            .map_err(|e| Error::from(e).wrap("아카이브의 경로를 확인하지 못했습니다"))?;
        if !self.inside(&real) {
            return Err(errorf!(
                "아카이브의 경로가 격리 칸 밖으로 이어집니다: {}",
                quote(dir)
            ));
        }
        Ok(goos::mkdir_all(dir, DIR_PERM)?)
    }

    /// 보통 파일 하나. 그 자리에 링크가 있으면 따라가지 않고 지운 뒤 쓴다.
    fn file(&mut self, target: &str, r: &mut dyn Read, perm: u32) -> Result<(), Error> {
        self.mkdir(&filepath::dir(target))?;
        if std::fs::symlink_metadata(target).is_ok_and(|m| m.file_type().is_symlink()) {
            goos::remove(target)?;
        }
        let mut br = BudgetReader {
            r,
            left: &mut self.left,
        };
        Ok(write_file(target, &mut br, perm)?)
    }

    /// 상대 경로이고 해석 결과가 칸 안인 링크만 만든다 (FR-EXT-39).
    fn symlink(&self, rel: &str, target: &str, link: &str) -> Result<(), Error> {
        check_link_target(rel, link)?;
        self.mkdir(&filepath::dir(target))?;
        let _ = goos::remove(target);
        make_symlink(link, target).map_err(|e| link_error("symlink", link, target, e))?;
        match filepath::eval_symlinks(target) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Ok(real) if self.inside(&real) => Ok(()),
            _ => {
                let _ = goos::remove(target);
                Err(errorf!(
                    "링크가 격리 칸 밖을 가리킵니다: {} → {}",
                    quote(rel),
                    quote(link)
                ))
            }
        }
    }

    /// tar 하드링크를 strip 을 적용한 칸 안의 보통 파일 사본으로 놓는다 (AT-EXT-8).
    fn hardlink(&mut self, target: &str, linkname: &str, strip: i64) -> Result<(), Error> {
        let Some(src_rel) = entry_path(linkname, strip)? else {
            return Err(errorf!("하드링크의 대상이 없습니다: {}", quote(linkname)));
        };
        let src = filepath::join(&[self.dest.as_str(), &src_rel]);
        let meta = match std::fs::symlink_metadata(&src) {
            Ok(m) if m.is_file() => m,
            _ => {
                return Err(errorf!(
                    "하드링크의 대상이 보통 파일이 아닙니다: {}",
                    quote(linkname)
                ));
            }
        };
        let real = match filepath::eval_symlinks(&src) {
            Ok(r) if self.inside(&r) => r,
            _ => {
                return Err(errorf!(
                    "하드링크가 격리 칸 밖을 가리킵니다: {}",
                    quote(linkname)
                ));
            }
        };
        let mut f = goos::open(&real)?;
        self.file(target, &mut f, perm_of(&meta))
    }
}

#[cfg(unix)]
fn perm_of(m: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    m.permissions().mode() & 0o777
}

/// Go 는 Windows 의 보통 파일을 0666(읽기 전용이면 0444)으로 본다.
#[cfg(not(unix))]
fn perm_of(m: &std::fs::Metadata) -> u32 {
    if m.permissions().readonly() {
        0o444
    } else {
        0o666
    }
}

#[cfg(unix)]
fn make_symlink(link: &str, target: &str) -> io::Result<()> {
    std::os::unix::fs::symlink(link, target)
}

/// Go `os.Symlink` (Windows): 대상이 디렉터리면 디렉터리 링크다.
#[cfg(windows)]
fn make_symlink(link: &str, target: &str) -> io::Result<()> {
    let resolved = filepath::join(&[filepath::dir(target).as_str(), link]);
    if std::fs::metadata(&resolved).is_ok_and(|m| m.is_dir()) {
        std::os::windows::fs::symlink_dir(link, target)
    } else {
        std::os::windows::fs::symlink_file(link, target)
    }
}

/// 해제 누적량을 남은 몫에서 깎고, 몫을 넘으면 [`Sentinel::ExtractTooLarge`] 다.
struct BudgetReader<'a> {
    r: &'a mut dyn Read,
    left: &'a mut i64,
}

impl Read for BudgetReader<'_> {
    fn read(&mut self, p: &mut [u8]) -> io::Result<usize> {
        let n = self.r.read(p)?;
        *self.left -= n as i64;
        if *self.left < 0 {
            return Err(Sentinel::ExtractTooLarge.io());
        }
        Ok(n)
    }
}

fn is_zip(p: &str) -> bool {
    let Ok(mut f) = File::open(p) else {
        return false;
    };
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).is_ok() && magic[0] == b'P' && magic[1] == b'K'
}

/// Go `io.ErrUnexpectedEOF` 등 아카이브 읽기 오류를 Go 문구에 가깝게 옮긴다.
fn archive_io_error(e: io::Error) -> Error {
    if e.kind() == io::ErrorKind::UnexpectedEof {
        return Error::new("unexpected EOF");
    }
    Error::from(e)
}

/// gzip 머리 10바이트. Go `gzip.NewReader` 는 여기서 실패를 가린다.
const GZIP_HEADER_LEN: usize = 10;

fn check_gzip_header(f: &mut File) -> Result<(), Error> {
    let mut head = [0u8; GZIP_HEADER_LEN];
    let mut n = 0;
    while n < head.len() {
        match f.read(&mut head[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(Error::from(e)),
        }
    }
    if n == 0 {
        return Err(Error::new("EOF"));
    }
    if n < GZIP_HEADER_LEN {
        return Err(Error::new("unexpected EOF"));
    }
    if head[0] != 0x1f || head[1] != 0x8b || head[2] != 8 {
        return Err(Error::new("gzip: invalid header"));
    }
    Ok(())
}

fn extract_tar_gz(archive: &str, u: &mut Unpacker, strip: i64) -> Result<(), Error> {
    let mut f = goos::open(archive)?;
    check_gzip_header(&mut f).map_err(|e| e.wrap("아카이브를 열지 못했습니다"))?;
    let f = goos::open(archive)?;
    let gz = flate2::read::MultiGzDecoder::new(f);
    let mut ar = tar::Archive::new(gz);
    let broken = |e: io::Error| archive_io_error(e).wrap("아카이브가 온전하지 않습니다");
    for entry in ar.entries().map_err(broken)? {
        let mut entry = entry.map_err(broken)?;
        let name = String::from_utf8_lossy(&entry.path_bytes()).into_owned();
        let Some(rel) = entry_path(&name, strip)? else {
            continue;
        };
        let target = filepath::join(&[u.dest.as_str(), &rel]);
        let raw_flag = entry.header().as_bytes()[156];
        let ty = entry.header().entry_type();
        // Go: 옛 정규 파일 표지(NUL)에 `/` 로 끝나는 이름은 디렉터리다.
        let is_dir = ty.is_dir() || (raw_flag == 0 && name.ends_with('/'));
        if is_dir {
            u.mkdir(&target)?;
        } else if ty.is_file() {
            let perm = entry.header().mode().unwrap_or(0) & 0o777;
            u.file(&target, &mut entry, perm)?;
        } else if ty.is_symlink() {
            let link = link_name(&entry);
            u.symlink(&rel, &target, &link)?;
        } else if ty.is_hard_link() {
            let link = link_name(&entry);
            u.hardlink(&target, &link, strip)?;
        }
        // 장치·FIFO 따위는 만들지 않는다.
    }
    Ok(())
}

fn link_name<R: Read>(entry: &tar::Entry<'_, R>) -> String {
    entry
        .link_name_bytes()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

// Go `archive/zip` 의 작성 OS 번호와 MS-DOS 속성.
const CREATOR_FAT: u8 = 0;
const CREATOR_UNIX: u8 = 3;
const CREATOR_NTFS: u8 = 11;
const CREATOR_VFAT: u8 = 14;
const CREATOR_MACOSX: u8 = 19;
const MSDOS_DIR: u32 = 0x10;
const MSDOS_READ_ONLY: u32 = 0x01;
const UNIX_TYPE_MASK: u32 = 0o170000;
const UNIX_TYPE_DIR: u32 = 0o040000;

/// Go `FileHeader.Mode()` 의 (디렉터리인가, 권한) 몫.
fn zip_mode(creator: u8, ext_attrs: u32, name: &str) -> (bool, u32) {
    let (mut dir, mut perm) = (false, 0);
    match creator {
        CREATOR_UNIX | CREATOR_MACOSX => {
            let m = ext_attrs >> 16;
            dir = m & UNIX_TYPE_MASK == UNIX_TYPE_DIR;
            perm = m & 0o777;
        }
        CREATOR_NTFS | CREATOR_VFAT | CREATOR_FAT => {
            if ext_attrs & MSDOS_DIR != 0 {
                (dir, perm) = (true, 0o777);
            } else {
                perm = 0o666;
            }
            if ext_attrs & MSDOS_READ_ONLY != 0 {
                perm &= !0o222;
            }
        }
        _ => {}
    }
    if name.ends_with('/') {
        dir = true;
    }
    (dir, perm)
}

fn zip_error(e: zip::result::ZipError) -> Error {
    match e {
        zip::result::ZipError::Io(e) => archive_io_error(e),
        zip::result::ZipError::InvalidArchive(_) => Error::new("zip: not a valid zip file"),
        zip::result::ZipError::CompressionMethodNotSupported(_) => {
            Error::new("zip: unsupported compression algorithm")
        }
        other => Error::new(other.to_string()),
    }
}

fn extract_zip(archive: &str, u: &mut Unpacker, strip: i64) -> Result<(), Error> {
    let f = goos::open(archive).map_err(|e| Error::from(e).wrap("아카이브를 열지 못했습니다"))?;
    let mut zr =
        zip::ZipArchive::new(f).map_err(|e| zip_error(e).wrap("아카이브를 열지 못했습니다"))?;
    for i in 0..zr.len() {
        let mut f = zr.by_index(i).map_err(zip_error)?;
        let name = String::from_utf8_lossy(f.name_raw()).into_owned();
        let Some(rel) = entry_path(&name, strip)? else {
            continue;
        };
        let target = filepath::join(&[u.dest.as_str(), &rel]);
        let (is_dir, perm) = zip_mode(f.system() as u8, f.external_attributes(), &name);
        if is_dir {
            u.mkdir(&target)?;
            continue;
        }
        u.file(&target, &mut f, perm)?;
    }
    Ok(())
}

/// 아카이브 엔트리 이름을 격리 칸 안의 상대경로로 푼다 (FR-EXT-39 / V-EXT-6). `None` 은 지난다.
pub(crate) fn entry_path(name: &str, strip: i64) -> Result<Option<String>, Error> {
    let n = name.replace('\\', "/");
    if n.starts_with('/') {
        return Err(errorf!(
            "아카이브가 절대경로를 담고 있습니다: {}",
            quote(name)
        ));
    }
    if n.len() >= 2 && n.as_bytes()[1] == b':' {
        return Err(errorf!(
            "아카이브가 드라이브 경로를 담고 있습니다: {}",
            quote(name)
        ));
    }
    // Clean **전에** 본다 — 가운데로 파고드는 갈래도 같은 자리에서 막힌다.
    if n.split('/').any(|s| s == "..") {
        return Err(errorf!(
            "아카이브가 상위 경로를 담고 있습니다: {}",
            quote(name)
        ));
    }
    let mut c = path::clean(&n);
    if c == "." || c.is_empty() {
        return Ok(None);
    }
    if strip > 0 {
        let segs: Vec<&str> = c.split('/').collect();
        let strip = usize::try_from(strip).unwrap_or(usize::MAX);
        if segs.len() <= strip {
            // 벗겨내면 남는 것이 없는 엔트리다 — 씌운 겹 자체이므로 지난다.
            return Ok(None);
        }
        c = segs[strip..].join("/");
    }
    Ok(Some(filepath::from_slash(&c)))
}

/// 링크가 격리 칸 안을 가리키는가.
pub(crate) fn check_link_target(rel: &str, link: &str) -> Result<(), Error> {
    if link.is_empty() {
        return Err(errorf!("링크가 빈 곳을 가리킵니다: {}", quote(rel)));
    }
    let l = link.replace('\\', "/");
    if l.starts_with('/') || (l.len() >= 2 && l.as_bytes()[1] == b':') {
        return Err(errorf!(
            "링크가 절대경로를 가리킵니다: {} → {}",
            quote(rel),
            quote(link)
        ));
    }
    let joined = path::join(&[path::dir(&filepath::to_slash(rel)).as_str(), &l]);
    if joined == ".." || joined.starts_with("../") {
        return Err(errorf!(
            "링크가 격리 칸 밖을 가리킵니다: {} → {}",
            quote(rel),
            quote(link)
        ));
    }
    Ok(())
}

/// Go 의 `writeFile`: 부모를 만들고, perm 0 이면 0644 로 열어 r 을 다 쓴다.
fn write_file(target: &str, r: &mut dyn Read, perm: u32) -> io::Result<()> {
    goos::mkdir_all(&filepath::dir(target), DIR_PERM)?;
    let perm = if perm == 0 { FILE_PERM } else { perm };
    let mut f = goos::create(target, perm)?;
    io::copy(r, &mut f)?;
    Ok(())
}
