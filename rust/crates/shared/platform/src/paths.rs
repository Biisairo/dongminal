//! 경로 규약과 파일 설치의 OS 차이 (FR-XPA-1).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::atomic::{copy_executable, file_perm, replace_file, temp_sibling};

/// 경로 규약과 파일 설치의 OS 차이.
pub trait Paths: Send + Sync {
    /// `--foreground` 가 아닌 기동이 출력을 남길 자리. 홈을 모를 때만 쓰인다.
    /// 상위 디렉터리는 없을 수 있다 — 호출자가 만든다.
    fn default_log_file(&self) -> PathBuf;
    /// 실행 파일의 확장자. POSIX 는 "", Windows 는 ".exe".
    fn exe_suffix(&self) -> &'static str;
    /// 절대경로를 `file://` URI 로 옮긴다.
    fn file_uri(&self, path: &str) -> String;
    /// 그 역이다. `file:` 이 아닌 URI 는 오류다.
    fn path_from_file_uri(&self, uri: &str) -> io::Result<String>;
    /// 실행할 수 있는 보통 파일인가 (FR-LWP-1). POSIX 는 실행 비트, Windows 는 확장자로 본다.
    fn is_executable(&self, path: &Path) -> bool;
    /// dst 가 src 의 실행 가능한 링크 또는 사본이 되게 한다. 옆에 만들고 rename 으로 덮는다 (FR-ATI-1).
    fn link_or_copy(&self, src: &Path, dst: &Path) -> io::Result<()>;
}

const LOG_BASE_NAME: &str = "dongminal.log";
#[cfg_attr(not(windows), allow(dead_code))]
const DEFAULT_PATH_EXT: &str = ".COM;.EXE;.BAT;.CMD";

pub(crate) fn current() -> &'static dyn Paths {
    #[cfg(windows)]
    {
        &WindowsPaths
    }
    #[cfg(not(windows))]
    {
        &PosixPaths
    }
}

/// "있고, 디렉터리가 아니다" (FR-LWP-4).
fn stat_regular(path: &Path) -> Option<fs::Metadata> {
    if path.as_os_str().is_empty() {
        return None;
    }
    fs::metadata(path).ok().filter(|m| !m.is_dir())
}

// ── posix ────────────────────────────────────────────

#[cfg_attr(windows, allow(dead_code))]
pub(crate) struct PosixPaths;

impl Paths for PosixPaths {
    fn default_log_file(&self) -> PathBuf {
        Path::new("/tmp").join(LOG_BASE_NAME)
    }

    fn exe_suffix(&self) -> &'static str {
        ""
    }

    fn file_uri(&self, path: &str) -> String {
        file_uri(path, false)
    }

    fn path_from_file_uri(&self, uri: &str) -> io::Result<String> {
        uri_slash_path(uri, false)
    }

    fn is_executable(&self, path: &Path) -> bool {
        stat_regular(path).is_some_and(|m| file_perm(&m) & 0o111 != 0)
    }

    fn link_or_copy(&self, src: &Path, dst: &Path) -> io::Result<()> {
        if fs::read_link(dst).is_ok_and(|existing| existing == src) {
            return Ok(());
        }
        let tmp = temp_sibling(dst);
        match symlink(src, &tmp) {
            Ok(()) => {
                if replace_file(&tmp, dst).is_ok() {
                    return Ok(());
                }
                let _ = fs::remove_file(&tmp);
            }
            Err(e) if e.kind() != io::ErrorKind::AlreadyExists => {
                // 심링크를 만들 수 없는 파일시스템이다. 복사로 물러선다.
                let _ = fs::remove_file(&tmp);
            }
            Err(_) => {}
        }
        copy_executable(src, dst)
    }
}

#[cfg(unix)]
fn symlink(src: &Path, dst: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(not(unix))]
#[allow(dead_code)]
fn symlink(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::from(io::ErrorKind::Unsupported))
}

// ── windows ──────────────────────────────────────────

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) struct WindowsPaths;

impl Paths for WindowsPaths {
    fn default_log_file(&self) -> PathBuf {
        windows_log_file(
            |k| {
                std::env::var_os(k)
                    .map(|v| v.to_string_lossy().into_owned())
                    .unwrap_or_default()
            },
            std::env::temp_dir,
        )
    }

    fn exe_suffix(&self) -> &'static str {
        ".exe"
    }

    fn file_uri(&self, path: &str) -> String {
        file_uri(&path.replace('\\', "/"), true)
    }

    fn path_from_file_uri(&self, uri: &str) -> io::Result<String> {
        Ok(uri_slash_path(uri, true)?.replace('/', "\\"))
    }

    fn is_executable(&self, path: &Path) -> bool {
        if stat_regular(path).is_none() {
            return false;
        }
        let pathext = std::env::var_os("PATHEXT")
            .map(|v| v.to_string_lossy().into_owned())
            .unwrap_or_default();
        win_executable_name(&path.to_string_lossy(), &pathext)
    }

    /// symlink 는 시도하지 않는다 (FR-XPA-3). 하드링크는 권한을 요구하지 않는다 (FR-HPR-11).
    fn link_or_copy(&self, src: &Path, dst: &Path) -> io::Result<()> {
        if same_file_at(src, dst) {
            return Ok(());
        }
        let tmp = temp_sibling(dst);
        if fs::hard_link(src, &tmp).is_ok() && replace_file(&tmp, dst).is_ok() {
            return Ok(());
        }
        let _ = fs::remove_file(&tmp);
        copy_executable(src, dst)
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
fn windows_log_file(env: impl Fn(&str) -> String, temp_dir: impl Fn() -> PathBuf) -> PathBuf {
    let base = env("LOCALAPPDATA");
    if !base.is_empty() {
        return Path::new(&base).join("dongminal").join(LOG_BASE_NAME);
    }
    // 서비스 계정 등 LOCALAPPDATA 가 비는 환경이 있다.
    temp_dir().join(LOG_BASE_NAME)
}

/// Windows `filepath.Ext` — 마지막 구분자(`\`·`/`) 뒤의 마지막 `.` 부터.
#[cfg_attr(not(windows), allow(dead_code))]
fn win_ext(path: &str) -> &str {
    for (i, c) in path.char_indices().rev() {
        match c {
            '\\' | '/' => return "",
            '.' => return &path[i..],
            _ => {}
        }
    }
    ""
}

#[cfg_attr(not(windows), allow(dead_code))]
fn win_executable_name(path: &str, pathext: &str) -> bool {
    let pathext = if pathext.is_empty() {
        DEFAULT_PATH_EXT
    } else {
        pathext
    };
    let ext = win_ext(path).to_uppercase();
    if ext.is_empty() {
        return false;
    }
    pathext.split(';').any(|want| {
        let want = want.trim().to_uppercase();
        if want.is_empty() {
            return false;
        }
        let want = if want.starts_with('.') {
            want
        } else {
            format!(".{want}")
        };
        ext == want
    })
}

/// 두 경로가 같은 실체인지 (Go `os.SameFile`).
#[cfg_attr(not(windows), allow(dead_code))]
fn same_file_at(a: &Path, b: &Path) -> bool {
    match (file_id(a), file_id(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

#[cfg(unix)]
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn file_id(p: &Path) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let m = fs::metadata(p).ok()?;
    Some((m.dev(), m.ino()))
}

#[cfg(windows)]
pub(crate) fn file_id(p: &Path) -> Option<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };
    let f = fs::File::open(p).ok()?;
    // SAFETY: 0 으로 채운 BY_HANDLE_FILE_INFORMATION 은 유효한 값이다(정수 필드만 있다).
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: f 가 살아 있는 동안의 유효한 핸들과, 쓰기 가능한 info 를 넘긴다.
    let ok = unsafe { GetFileInformationByHandle(f.as_raw_handle(), &mut info) };
    if ok == 0 {
        return None;
    }
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    Some((u64::from(info.dwVolumeSerialNumber), index))
}

// ── file URI ─────────────────────────────────────────

/// Go `shouldEscape(c, encodePath)` 의 반대 — 그대로 두는 바이트.
fn path_safe(b: u8) -> bool {
    b.is_ascii_alphanumeric()
        || matches!(
            b,
            b'-' | b'_'
                | b'.'
                | b'~'
                | b'$'
                | b'&'
                | b'+'
                | b','
                | b'/'
                | b':'
                | b';'
                | b'='
                | b'@'
        )
}

/// Go `url.URL{Scheme: "file", Path: p}.String()`.
fn file_uri(slash_path: &str, leading_slash: bool) -> String {
    let p = if leading_slash && !slash_path.starts_with('/') {
        format!("/{slash_path}")
    } else {
        slash_path.to_owned()
    };
    let mut out = String::from("file:");
    if !p.is_empty() {
        out.push_str("//");
    }
    for &b in p.as_bytes() {
        if path_safe(b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn parse_err(uri: &str, msg: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("parse {}: {msg}", dm_gocompat::strconv::quote(uri)),
    )
}

/// Go `url.unescape(s, encodePath)`.
fn unescape_path(uri: &str, s: &str) -> io::Result<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = |c: u8| char::from(c).to_digit(16);
            match (
                b.get(i + 1).copied().and_then(hex),
                b.get(i + 2).copied().and_then(hex),
            ) {
                (Some(h), Some(l)) => {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                _ => {
                    let bad = &s[i..s.len().min(i + 3)];
                    let msg = format!("invalid URL escape {}", dm_gocompat::strconv::quote(bad));
                    return Err(parse_err(uri, &msg));
                }
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("platform: file uri path is not UTF-8: {uri}"),
        )
    })
}

/// Go `url.Parse` 에서 scheme 과 path 만 꺼낸다. 호스트 검증은 하지 않는다.
fn parse_scheme_path(uri: &str) -> io::Result<(String, String)> {
    if uri.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return Err(parse_err(uri, "net/url: invalid control character in URL"));
    }
    let (without_frag, _) = uri.split_once('#').unwrap_or((uri, ""));
    let (scheme, rest) = split_scheme(without_frag).map_err(|m| parse_err(uri, m))?;
    let rest = match rest.strip_suffix('?') {
        Some(r) if rest.matches('?').count() == 1 => r,
        _ => rest.split_once('?').map_or(rest, |(r, _)| r),
    };
    if !rest.starts_with('/') {
        // scheme 이 있으면 opaque 다 — Go 는 Path 를 비운다.
        return Ok((scheme, String::new()));
    }
    let path = match rest.strip_prefix("//") {
        Some(auth) if !scheme.is_empty() => auth.find('/').map_or("", |i| &auth[i..]),
        _ => rest,
    };
    Ok((scheme, unescape_path(uri, path)?))
}

/// Go `getScheme`. scheme 은 소문자로 낮춘다.
fn split_scheme(raw: &str) -> Result<(String, &str), &'static str> {
    for (i, c) in raw.char_indices() {
        match c {
            'a'..='z' | 'A'..='Z' => {}
            '0'..='9' | '+' | '-' | '.' if i > 0 => {}
            ':' if i == 0 => return Err("missing protocol scheme"),
            ':' => return Ok((raw[..i].to_ascii_lowercase(), &raw[i + 1..])),
            _ => return Ok((String::new(), raw)),
        }
    }
    Ok((String::new(), raw))
}

fn uri_slash_path(uri: &str, trim_leading: bool) -> io::Result<String> {
    if uri.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "platform: empty file uri",
        ));
    }
    let (scheme, path) = parse_scheme_path(uri)?;
    if scheme != "file" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("platform: not a file uri: {uri}"),
        ));
    }
    Ok(match (trim_leading, path.strip_prefix('/')) {
        (true, Some(p)) => p.to_owned(),
        _ => path,
    })
}

#[cfg(test)]
mod tests;
