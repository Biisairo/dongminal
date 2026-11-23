//! `GET /api/fs/download-dir`·`/api/fs/download-many` — 폴더·여러 항목을 zip 으로 흘려보낸다 (Go
//! `handlers_fs_zip.go`, EXPLORER_TRANSFER_IGNORE_SRS 묶음 B, UX_BATCH12_SRS FR-EXD-3·4).
//!
//! **순서가 설계다.** 자리 잡기와 세기가 머리 쓰기보다 **먼저**다 (D-6). 스트리밍이 시작된 뒤의
//! 실패는 그 파일을 건너뛰는 것으로만 다룬다 (FR-ETR-15).
//!
//! zip 컨테이너(로컬 머리·데이터 기술자·중앙 디렉터리·확장 시각 extra·모드)는 Go `archive/zip`
//! 의 Writer 와 바이트까지 같다. 압축 스트림만 flate2 다 — Go `compress/flate` 레벨 5 와 같은
//! 내용을 다른 바이트로 압축한다(SRS 3.7 DIFF-24).

use std::fs::{FileType, Metadata};
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::SystemTime;

use bytes::Bytes;
use dm_gocompat::filepath;
use dm_shared_httpresp::{self as httpresp, Response};
use dm_webserver_apierr as apierr;
use flate2::Compression;
use flate2::write::DeflateEncoder;
use http::{HeaderValue, header};
use http_body_util::{BodyExt, StreamBody};

use crate::Server;
use crate::files_transfer::attachment_disposition;
use crate::fs::{
    FS_ERR_BAD_REQUEST, FsError, fs_fail, fs_fail_err, fs_from_io, fs_resolve_existing,
};
use crate::req::Req;

/// FR-ETR-45: 지금은 자리가 없다 — 재시도가 유효하다.
pub(crate) const FS_ERR_BUSY: &str = apierr::CODE_BUSY;

/// FR-ETR-12: 항목 수 상한.
pub(crate) const ZIP_MAX_ENTRIES: usize = 50000;
/// FR-ETR-12: 압축 **전** 총 바이트의 상한.
pub(crate) const ZIP_MAX_BYTES: i64 = 2 << 30;
/// FR-ETR-45 (`SEC-20`): 동시 요청 상한.
pub(crate) const ZIP_MAX_CONCURRENT: i64 = 2;

/// 클라이언트의 `<a download>` 이름과 서버의 머리가 어긋나지 않게 한 자리에 둔다 (FR-ETR-10).
const ZIP_SUFFIX: &str = ".zip";

const BUSY_MSG: &str = "동시 다운로드가 상한에 닿았다 — 잠시 뒤 다시 시도하세요";
const OVER_MSG: &str = "폴더가 상한을 넘었다 — 더 작은 폴더를 받으세요";

/// 응답 본문으로 보내는 조각의 크기다.
const ZIP_CHUNK: usize = 32 << 10;

/// zip 내려받기의 상한과 지금 흐르는 수다 (Go 패키지 변수 `zipMax*`·`zipInFlight`). 서버마다
/// 두는 것은 시험이 값을 낮추기 위해서다.
#[derive(Debug)]
pub(crate) struct ZipLimits {
    pub(crate) in_flight: Arc<AtomicI64>,
    pub(crate) max_entries: usize,
    pub(crate) max_bytes: i64,
    pub(crate) max_concurrent: i64,
}

impl Default for ZipLimits {
    fn default() -> Self {
        ZipLimits {
            in_flight: Arc::new(AtomicI64::new(0)),
            max_entries: ZIP_MAX_ENTRIES,
            max_bytes: ZIP_MAX_BYTES,
            max_concurrent: ZIP_MAX_CONCURRENT,
        }
    }
}

/// 잡은 자리 하나. 놓이면 자리를 돌려준다.
struct Slot(Arc<AtomicI64>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl ZipLimits {
    /// FR-ETR-45: 자리를 **머리보다 먼저** 잡는다.
    fn acquire(&self) -> Option<Slot> {
        if self.in_flight.fetch_add(1, Ordering::SeqCst) + 1 > self.max_concurrent {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Slot(Arc::clone(&self.in_flight)))
    }
}

fn os_bytes(n: &std::ffi::OsStr) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        n.as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        n.to_string_lossy().into_owned().into_bytes()
    }
}

/// 이름 순(Go `os.ReadDir`)으로 읽은 한 겹이다.
fn read_dir_sorted(dir: &Path) -> io::Result<Vec<std::fs::DirEntry>> {
    let mut v = std::fs::read_dir(dir)?.collect::<io::Result<Vec<_>>>()?;
    v.sort_by_key(std::fs::DirEntry::file_name);
    Ok(v)
}

/// Go `zipDownloadName`: 이름이 비면 `download.zip` 이다.
pub(crate) fn zip_download_name(dir: &str) -> String {
    let base = filepath::base(dir);
    if base.is_empty() || base == std::path::MAIN_SEPARATOR_STR || base.trim().is_empty() {
        return format!("download{ZIP_SUFFIX}");
    }
    format!("{base}{ZIP_SUFFIX}")
}

/// Go `zipManyName`: `<루트 이름>-<n>-items.zip`.
pub(crate) fn zip_many_name(root: &str, n: usize) -> String {
    let name = zip_download_name(root);
    let stem = name.strip_suffix(ZIP_SUFFIX).unwrap_or(&name);
    format!("{stem}-{n}-items{ZIP_SUFFIX}")
}

enum CountErr {
    Over,
    Io(io::Error),
}

struct Counter {
    entries: usize,
    total: i64,
    max_entries: usize,
    max_bytes: i64,
}

impl Counter {
    /// Go `zipCountInto`: 링크는 세지 않는다. 읽을 수 없는(권한) 자리는 건너뛴다.
    fn node(
        &mut self,
        path: &Path,
        ft: FileType,
        meta: &dyn Fn() -> Option<Metadata>,
    ) -> Result<(), CountErr> {
        if ft.is_symlink() {
            return Ok(());
        }
        self.entries += 1;
        if self.entries > self.max_entries {
            return Err(CountErr::Over);
        }
        if ft.is_dir() {
            let list = match read_dir_sorted(path) {
                Ok(v) => v,
                Err(e) if e.kind() == io::ErrorKind::PermissionDenied => return Ok(()),
                Err(e) => return Err(CountErr::Io(e)),
            };
            for e in list {
                let Ok(cft) = e.file_type() else {
                    continue;
                };
                self.node(&e.path(), cft, &|| e.metadata().ok())?;
            }
            return Ok(());
        }
        let Some(m) = meta() else {
            return Ok(());
        };
        self.total += m.len() as i64;
        if self.total > self.max_bytes {
            return Err(CountErr::Over);
        }
        Ok(())
    }

    fn root(&mut self, root: &str) -> Result<(), CountErr> {
        let p = Path::new(root);
        let st = match std::fs::symlink_metadata(p) {
            Ok(st) => st,
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied => return Ok(()),
            Err(e) => return Err(CountErr::Io(e)),
        };
        let ft = st.file_type();
        self.node(p, ft, &|| Some(st.clone()))
    }
}

/// Go `zipWithinLimits`: 항목 수와 총 바이트를 함께 센다. 뿌리가 여럿이면 상한은 **합**이다
/// (FR-EXD-4).
pub(crate) fn zip_within_limits(
    roots: &[String],
    max_entries: usize,
    max_bytes: i64,
) -> Result<(), FsError> {
    let mut c = Counter {
        entries: 0,
        total: 0,
        max_entries,
        max_bytes,
    };
    for r in roots {
        match c.root(r) {
            Ok(()) => {}
            Err(CountErr::Over) => return Err(FsError::new(FS_ERR_BAD_REQUEST, OVER_MSG)),
            Err(CountErr::Io(e)) => return Err(fs_from_io(&e)),
        }
    }
    Ok(())
}

// ── Go archive/zip Writer ──────────────────────────────────────────────────────────

const FILE_HEADER_SIGNATURE: u32 = 0x0403_4b50;
const DIRECTORY_HEADER_SIGNATURE: u32 = 0x0201_4b50;
const DIRECTORY_END_SIGNATURE: u32 = 0x0605_4b50;
const DIRECTORY64_LOC_SIGNATURE: u32 = 0x0706_4b50;
const DIRECTORY64_END_SIGNATURE: u32 = 0x0606_4b50;
const DATA_DESCRIPTOR_SIGNATURE: u32 = 0x0807_4b50;
const DIRECTORY64_END_LEN: u64 = 56;
const ZIP_VERSION_20: u16 = 20;
const ZIP_VERSION_45: u16 = 45;
const CREATOR_UNIX: u16 = 3;
const ZIP64_EXTRA_ID: u16 = 0x0001;
const EXT_TIME_EXTRA_ID: u16 = 0x5455;
const METHOD_STORE: u16 = 0;
const METHOD_DEFLATE: u16 = 8;
const FLAG_DATA_DESCRIPTOR: u16 = 0x8;
const FLAG_UTF8: u16 = 0x800;
const UINT16_MAX: u64 = (1 << 16) - 1;
const UINT32_MAX: u64 = (1 << 32) - 1;
const S_IFREG: u32 = 0x8000;
const MSDOS_READ_ONLY: u32 = 0x01;
/// Go `flate.NewWriter(w, 5)` 의 레벨이다.
const DEFLATE_LEVEL: u32 = 5;

struct CountWriter<W> {
    w: W,
    count: u64,
}

impl<W: Write> Write for CountWriter<W> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        let n = self.w.write(b)?;
        self.count += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.w.flush()
    }
}

struct Header {
    name: Vec<u8>,
    creator: u16,
    reader: u16,
    flags: u16,
    method: u16,
    mod_time: u16,
    mod_date: u16,
    crc: u32,
    csize: u64,
    usize: u64,
    extra: Vec<u8>,
    ext_attrs: u32,
    offset: u64,
}

/// 파일 하나의 시각과 모드 (Go `FileHeader.Modified`·`SetMode`).
pub(crate) struct FileInfo {
    pub(crate) modified: SystemTime,
    /// unix 모드(형식 비트 없이 `0o7777` 안의 값).
    pub(crate) perm: u32,
}

/// Go `detectUTF8`: 잘못된 바이트가 하나라도 있으면 (false, false) 다.
fn detect_utf8(s: &[u8]) -> (bool, bool) {
    let Ok(v) = std::str::from_utf8(s) else {
        return (false, false);
    };
    let require = v.chars().any(|r| {
        let c = r as u32;
        !(0x20..=0x7d).contains(&c) || c == 0x5c
    });
    (true, require)
}

/// Go `timeToMsDosTime`: 지역 시각으로 접는다.
fn ms_dos_time(t: SystemTime) -> (u16, u16) {
    let lt = dm_gocompat::time::to_zone(time::OffsetDateTime::from(t), dm_gocompat::time::local());
    let date = (i64::from(lt.day())
        + (i64::from(u8::from(lt.month())) << 5)
        + ((i64::from(lt.year()) - 1980) << 9)) as u16;
    let time = (i64::from(lt.second()) / 2
        + (i64::from(lt.minute()) << 5)
        + (i64::from(lt.hour()) << 11)) as u16;
    (date, time)
}

fn unix_secs(t: SystemTime) -> i64 {
    match t.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(e) => {
            let d = e.duration();
            -(d.as_secs() as i64) - i64::from(d.subsec_nanos() > 0)
        }
    }
}

/// Go `archive/zip.Writer` 중 이 종단이 쓰는 부분(`Create`·`CreateHeader`·`Close`)이다.
pub(crate) struct ZipWriter<W: Write> {
    w: CountWriter<W>,
    dir: Vec<Header>,
}

impl<W: Write> ZipWriter<W> {
    pub(crate) fn new(w: W) -> Self {
        ZipWriter {
            w: CountWriter { w, count: 0 },
            dir: Vec::new(),
        }
    }

    fn header(&mut self, name: &[u8], method: u16, info: Option<&FileInfo>) -> Header {
        let (valid, require) = detect_utf8(name);
        let mut h = Header {
            name: name.to_vec(),
            creator: ZIP_VERSION_20,
            reader: ZIP_VERSION_20,
            flags: 0,
            method,
            mod_time: 0,
            mod_date: 0,
            crc: 0,
            csize: 0,
            usize: 0,
            extra: Vec::new(),
            ext_attrs: 0,
            offset: self.w.count,
        };
        if require && valid {
            h.flags |= FLAG_UTF8;
        }
        if let Some(fi) = info {
            h.creator = (CREATOR_UNIX << 8) | ZIP_VERSION_20;
            h.ext_attrs = (S_IFREG | (fi.perm & 0o7777)) << 16;
            if fi.perm & 0o200 == 0 {
                h.ext_attrs |= MSDOS_READ_ONLY;
            }
            (h.mod_date, h.mod_time) = ms_dos_time(fi.modified);
            h.extra.extend_from_slice(&EXT_TIME_EXTRA_ID.to_le_bytes());
            h.extra.extend_from_slice(&5u16.to_le_bytes());
            h.extra.push(1);
            h.extra
                .extend_from_slice(&(unix_secs(fi.modified) as u32).to_le_bytes());
        }
        h
    }

    fn write_local(&mut self, h: &Header) -> io::Result<()> {
        let mut b = Vec::with_capacity(30 + h.name.len() + h.extra.len());
        b.extend_from_slice(&FILE_HEADER_SIGNATURE.to_le_bytes());
        b.extend_from_slice(&h.reader.to_le_bytes());
        b.extend_from_slice(&h.flags.to_le_bytes());
        b.extend_from_slice(&h.method.to_le_bytes());
        b.extend_from_slice(&h.mod_time.to_le_bytes());
        b.extend_from_slice(&h.mod_date.to_le_bytes());
        b.extend_from_slice(&[0; 12]);
        b.extend_from_slice(&(h.name.len() as u16).to_le_bytes());
        b.extend_from_slice(&(h.extra.len() as u16).to_le_bytes());
        b.extend_from_slice(&h.name);
        b.extend_from_slice(&h.extra);
        self.w.write_all(&b)
    }

    /// Go `Create(name)` 로 디렉터리(`…/`)를 담는다: 저장 방식·데이터 기술자 없음.
    pub(crate) fn create_dir(&mut self, name: &[u8]) -> io::Result<()> {
        let h = self.header(name, METHOD_STORE, None);
        self.write_local(&h)?;
        self.dir.push(h);
        Ok(())
    }

    /// 파일 하나를 deflate 로 담는다. 원본 읽기의 실패는 그때까지 읽은 것으로 엔트리를 닫는다
    /// (Go `io.Copy` 가 멈춘 자리). 돌려주는 오류는 받는 쪽 쓰기의 실패뿐이다.
    pub(crate) fn add_file(
        &mut self,
        name: &[u8],
        info: Option<&FileInfo>,
        src: &mut dyn Read,
    ) -> io::Result<()> {
        let mut h = self.header(name, METHOD_DEFLATE, info);
        h.flags |= FLAG_DATA_DESCRIPTOR;
        self.write_local(&h)?;
        let start = self.w.count;
        let mut crc = flate2::Crc::new();
        let mut raw = 0u64;
        {
            let mut enc = DeflateEncoder::new(&mut self.w, Compression::new(DEFLATE_LEVEL));
            let mut buf = vec![0u8; ZIP_CHUNK];
            loop {
                let n = match src.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                crc.update(&buf[..n]);
                raw += n as u64;
                enc.write_all(&buf[..n])?;
            }
            enc.finish()?;
        }
        h.crc = crc.sum();
        h.csize = self.w.count - start;
        h.usize = raw;
        let big = h.csize > UINT32_MAX || h.usize > UINT32_MAX;
        let mut d = Vec::with_capacity(24);
        d.extend_from_slice(&DATA_DESCRIPTOR_SIGNATURE.to_le_bytes());
        d.extend_from_slice(&h.crc.to_le_bytes());
        if big {
            h.reader = ZIP_VERSION_45;
            d.extend_from_slice(&h.csize.to_le_bytes());
            d.extend_from_slice(&h.usize.to_le_bytes());
        } else {
            d.extend_from_slice(&(h.csize as u32).to_le_bytes());
            d.extend_from_slice(&(h.usize as u32).to_le_bytes());
        }
        self.w.write_all(&d)?;
        self.dir.push(h);
        Ok(())
    }

    /// Go `Close`: 중앙 디렉터리와 끝 레코드를 쓴다.
    pub(crate) fn close(mut self) -> io::Result<W> {
        let start = self.w.count;
        let mut used64 = false;
        let dir = std::mem::take(&mut self.dir);
        for mut h in dir {
            let mut reader = h.reader;
            if h.csize >= UINT32_MAX || h.usize >= UINT32_MAX || h.offset >= UINT32_MAX {
                used64 = true;
                reader = reader.max(ZIP_VERSION_45);
                let mut body = Vec::new();
                if h.usize >= UINT32_MAX {
                    body.extend_from_slice(&h.usize.to_le_bytes());
                }
                if h.csize >= UINT32_MAX {
                    body.extend_from_slice(&h.csize.to_le_bytes());
                }
                if h.offset >= UINT32_MAX {
                    body.extend_from_slice(&h.offset.to_le_bytes());
                }
                h.extra.extend_from_slice(&ZIP64_EXTRA_ID.to_le_bytes());
                h.extra
                    .extend_from_slice(&(body.len() as u16).to_le_bytes());
                h.extra.extend_from_slice(&body);
            }
            let mut b = Vec::with_capacity(46 + h.name.len() + h.extra.len());
            b.extend_from_slice(&DIRECTORY_HEADER_SIGNATURE.to_le_bytes());
            b.extend_from_slice(&h.creator.to_le_bytes());
            b.extend_from_slice(&reader.to_le_bytes());
            b.extend_from_slice(&h.flags.to_le_bytes());
            b.extend_from_slice(&h.method.to_le_bytes());
            b.extend_from_slice(&h.mod_time.to_le_bytes());
            b.extend_from_slice(&h.mod_date.to_le_bytes());
            b.extend_from_slice(&h.crc.to_le_bytes());
            b.extend_from_slice(&(h.csize.min(UINT32_MAX) as u32).to_le_bytes());
            b.extend_from_slice(&(h.usize.min(UINT32_MAX) as u32).to_le_bytes());
            b.extend_from_slice(&(h.name.len() as u16).to_le_bytes());
            b.extend_from_slice(&(h.extra.len() as u16).to_le_bytes());
            b.extend_from_slice(&[0; 6]);
            b.extend_from_slice(&h.ext_attrs.to_le_bytes());
            b.extend_from_slice(&(h.offset.min(UINT32_MAX) as u32).to_le_bytes());
            b.extend_from_slice(&h.name);
            b.extend_from_slice(&h.extra);
            self.w.write_all(&b)?;
            self.dir.push(h);
        }
        let end = self.w.count;
        let records = self.dir.len() as u64;
        let size = end - start;
        let offset = start;
        let mut b = Vec::with_capacity(98);
        if used64 || records >= UINT16_MAX || size >= UINT32_MAX || offset >= UINT32_MAX {
            b.extend_from_slice(&DIRECTORY64_END_SIGNATURE.to_le_bytes());
            b.extend_from_slice(&(DIRECTORY64_END_LEN - 12).to_le_bytes());
            b.extend_from_slice(&ZIP_VERSION_45.to_le_bytes());
            b.extend_from_slice(&ZIP_VERSION_45.to_le_bytes());
            b.extend_from_slice(&[0; 8]);
            b.extend_from_slice(&records.to_le_bytes());
            b.extend_from_slice(&records.to_le_bytes());
            b.extend_from_slice(&size.to_le_bytes());
            b.extend_from_slice(&offset.to_le_bytes());
            b.extend_from_slice(&DIRECTORY64_LOC_SIGNATURE.to_le_bytes());
            b.extend_from_slice(&0u32.to_le_bytes());
            b.extend_from_slice(&end.to_le_bytes());
            b.extend_from_slice(&1u32.to_le_bytes());
        }
        b.extend_from_slice(&DIRECTORY_END_SIGNATURE.to_le_bytes());
        b.extend_from_slice(&[0; 4]);
        b.extend_from_slice(&(records.min(UINT16_MAX) as u16).to_le_bytes());
        b.extend_from_slice(&(records.min(UINT16_MAX) as u16).to_le_bytes());
        b.extend_from_slice(&(size.min(UINT32_MAX) as u32).to_le_bytes());
        b.extend_from_slice(&(offset.min(UINT32_MAX) as u32).to_le_bytes());
        b.extend_from_slice(&0u16.to_le_bytes());
        self.w.write_all(&b)?;
        self.w.flush()?;
        Ok(self.w.w)
    }
}

// ── 트리 담기 ─────────────────────────────────────────────────────────────────────

#[cfg(unix)]
fn file_info(m: &Metadata) -> Option<FileInfo> {
    use std::os::unix::fs::MetadataExt;
    Some(FileInfo {
        modified: m.modified().ok()?,
        perm: m.mode() & 0o7777,
    })
}

#[cfg(not(unix))]
fn file_info(m: &Metadata) -> Option<FileInfo> {
    Some(FileInfo {
        modified: m.modified().ok()?,
        perm: if m.permissions().readonly() {
            0o444
        } else {
            0o666
        },
    })
}

/// Go `zipEntryName`: 대상 이름을 뿌리로 하는 슬래시 경로다.
fn entry_name(base: &[u8], rel: &[u8]) -> Vec<u8> {
    if rel.is_empty() {
        return base.to_vec();
    }
    let mut n = base.to_vec();
    if !n.ends_with(b"/") {
        n.push(b'/');
    }
    n.extend_from_slice(rel);
    n
}

fn join_rel(rel: &[u8], name: &[u8]) -> Vec<u8> {
    if rel.is_empty() {
        return name.to_vec();
    }
    let mut v = rel.to_vec();
    v.push(b'/');
    v.extend_from_slice(name);
    v
}

/// Go `writeZipFile`: 열지 못하면 조용히 건너뛴다 (FR-ETR-15).
fn zip_file<W: Write>(
    zw: &mut ZipWriter<W>,
    p: &Path,
    name: &[u8],
    meta: Option<Metadata>,
) -> io::Result<()> {
    let Ok(mut f) = std::fs::File::open(p) else {
        return Ok(());
    };
    let info = meta.as_ref().and_then(file_info);
    zw.add_file(name, info.as_ref(), &mut f)
}

fn zip_node<W: Write>(
    zw: &mut ZipWriter<W>,
    p: &Path,
    ft: FileType,
    meta: Option<Metadata>,
    base: &[u8],
    rel: &[u8],
    is_root: bool,
) -> io::Result<()> {
    // FR-ETR-14: 링크는 담지 않는다 (D-7).
    if ft.is_symlink() {
        return Ok(());
    }
    let name = entry_name(base, rel);
    if ft.is_dir() {
        // 루트 자신은 엔트리로 넣지 않는다. 빈 디렉터리는 넣어야 구조가 보존된다 (FR-ETR-14).
        if !is_root {
            let mut d = name;
            d.push(b'/');
            zw.create_dir(&d)?;
        }
        let Ok(list) = read_dir_sorted(p) else {
            return Ok(());
        };
        for e in list {
            let Ok(cft) = e.file_type() else {
                continue;
            };
            let crel = join_rel(rel, &os_bytes(&e.file_name()));
            zip_node(zw, &e.path(), cft, e.metadata().ok(), base, &crel, false)?;
        }
        return Ok(());
    }
    if !ft.is_file() {
        return Ok(());
    }
    zip_file(zw, p, &name, meta)
}

/// Go `zipAddTree`: 뿌리 하나를 그 이름 아래에 담는다. 파일이면 그 파일 하나다 (FR-EXD-4).
fn zip_add_tree<W: Write>(zw: &mut ZipWriter<W>, root: &str) -> io::Result<()> {
    let p = Path::new(root);
    let Ok(st) = std::fs::symlink_metadata(p) else {
        return Ok(());
    };
    let base = p
        .file_name()
        .map_or_else(|| filepath::base(root).into_bytes(), os_bytes);
    let ft = st.file_type();
    zip_node(zw, p, ft, Some(st), &base, b"", true)
}

/// Go `writeZipTree`: 머리가 이미 나갔으므로 받는 쪽 쓰기가 실패하면 멈출 뿐이다.
pub(crate) fn write_zip_tree<W: Write>(w: W, roots: &[String]) -> io::Result<W> {
    let mut zw = ZipWriter::new(w);
    for r in roots {
        zip_add_tree(&mut zw, r)?;
    }
    zw.close()
}

/// 응답 본문으로 조각을 넘기는 쓰기 자리다.
struct ChanWriter {
    tx: tokio::sync::mpsc::Sender<Bytes>,
    buf: Vec<u8>,
}

impl ChanWriter {
    fn send(&mut self) -> io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let b = Bytes::from(std::mem::take(&mut self.buf));
        self.tx
            .blocking_send(b)
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))
    }
}

impl Write for ChanWriter {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(b);
        if self.buf.len() >= ZIP_CHUNK {
            self.send()?;
        }
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.send()
    }
}

/// 머리를 싣고 zip 을 흘려보낸다. 자리는 쓰기가 끝날 때 놓인다.
fn zip_response(slot: Slot, name: &str, roots: Vec<String>) -> Response {
    let (tx, rx) = tokio::sync::mpsc::channel::<Bytes>(4);
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        let _ = write_zip_tree(
            ChanWriter {
                tx,
                buf: Vec::with_capacity(ZIP_CHUNK),
            },
            &roots,
        );
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|b| (Ok::<_, httpresp::BoxError>(hyper::body::Frame::data(b)), rx))
    });
    let mut res = http::Response::new(StreamBody::new(stream).boxed());
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    if let Ok(v) = HeaderValue::from_str(&attachment_disposition(name)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    res
}

async fn off_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(f).await {
        Ok(v) => v,
        Err(e) => std::panic::resume_unwind(e.into_panic()),
    }
}

impl Server {
    async fn zip_check(&self, roots: Vec<String>) -> Result<Vec<String>, Response> {
        let (me, mb) = (self.fs.zip.max_entries, self.fs.zip.max_bytes);
        off_thread(move || zip_within_limits(&roots, me, mb).map(|()| roots))
            .await
            .map_err(|e| fs_fail_err(&e))
    }

    /// GET /api/fs/download-dir — 폴더를 zip 으로 흘려보낸다 (FR-ETR-9~16).
    pub(crate) async fn api_fs_download_dir(&self, r: &mut Req) -> Response {
        let Some(slot) = self.fs.zip.acquire() else {
            return fs_fail(FS_ERR_BUSY, BUSY_MSG);
        };
        let root = match self.fs_root(&r.q("root")) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let target = match fs_resolve_existing(&root, &r.q("path")) {
            Ok(v) => v,
            Err(e) => return fs_fail_err(&e),
        };
        let st = match std::fs::metadata(&target) {
            Ok(st) => st,
            Err(e) => return fs_fail_err(&fs_from_io(&e)),
        };
        // FR-ETR-11: 파일은 /api/fs/download 의 자리다.
        if !st.is_dir() {
            return fs_fail(FS_ERR_BAD_REQUEST, "디렉터리가 아니다");
        }
        let roots = match self.zip_check(vec![target.clone()]).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        zip_response(slot, &zip_download_name(&target), roots)
    }

    /// GET /api/fs/download-many — 여러 경로를 zip 하나로 준다 (FR-EXD-3·4·7).
    pub(crate) async fn api_fs_download_many(&self, r: &mut Req) -> Response {
        let Some(slot) = self.fs.zip.acquire() else {
            return fs_fail(FS_ERR_BUSY, BUSY_MSG);
        };
        let root = match self.fs_root(&r.q("root")) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let q = r.query();
        let paths: Vec<String> = q
            .get_all("path")
            .unwrap_or_default()
            .iter()
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect();
        if paths.is_empty() {
            return fs_fail(FS_ERR_BAD_REQUEST, "내려받을 경로가 없다");
        }
        let mut targets = Vec::with_capacity(paths.len());
        let mut names = std::collections::HashSet::new();
        for p in &paths {
            let target = match fs_resolve_existing(&root, p) {
                Ok(v) => v,
                Err(e) => return fs_fail_err(&e),
            };
            // 맨 위 이름이 겹치면 푸는 쪽에서 한쪽이 다른 쪽을 덮는다.
            let name = filepath::base(&target);
            if !names.insert(name.clone()) {
                return fs_fail(FS_ERR_BAD_REQUEST, &format!("같은 이름이 둘이다: {name}"));
            }
            targets.push(target);
        }
        let n = targets.len();
        let roots = match self.zip_check(targets).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        zip_response(slot, &zip_many_name(&root, n), roots)
    }
}
