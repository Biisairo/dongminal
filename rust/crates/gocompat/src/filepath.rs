//! Go `path/filepath` 의 규칙이다 (go1.27.2 `internal/filepathlite`·`path/filepath`).
//!
//! 규칙은 두 벌의 순수 함수다: [`unix`] 와 [`windows`]. 어느 호스트에서도 둘 다 시험할 수
//! 있다. 이 모듈 맨 위의 함수는 빌드 대상 OS 의 규칙을 고른다. 바이트 단위로 다룬다 —
//! 구분자·`:`·`.` 이 모두 ASCII 라 UTF-8 경계를 가르지 않는다.

use std::io;

#[cfg(not(windows))]
use self::unix as os;
#[cfg(windows)]
use self::windows as os;

pub use os::{LIST_SEPARATOR, SEPARATOR};

/// Go `filepath.Clean`.
pub fn clean(path: &str) -> String {
    os::clean(path)
}
/// Go `filepath.Join`.
pub fn join<S: AsRef<str>>(elem: &[S]) -> String {
    os::join(elem)
}
/// Go `filepath.IsAbs`.
pub fn is_abs(path: &str) -> bool {
    os::is_abs(path)
}
/// Go `filepath.VolumeName`.
pub fn volume_name(path: &str) -> String {
    os::volume_name(path)
}
/// Go `filepath.ToSlash`.
pub fn to_slash(path: &str) -> String {
    os::to_slash(path)
}
/// Go `filepath.FromSlash`.
pub fn from_slash(path: &str) -> String {
    os::from_slash(path)
}
/// Go `filepath.Dir`.
pub fn dir(path: &str) -> String {
    os::dir(path)
}
/// Go `filepath.Base`.
pub fn base(path: &str) -> String {
    os::base(path)
}
/// Go `filepath.Ext`.
pub fn ext(path: &str) -> &str {
    os::ext(path)
}
/// Go `filepath.Split`.
pub fn split(path: &str) -> (&str, &str) {
    os::split(path)
}
/// Go `filepath.SplitList`.
pub fn split_list(path: &str) -> Vec<String> {
    os::split_list(path)
}
/// Go `filepath.Rel`. 오류 문구는 Go 와 같다 (`Rel: can't make <targ> relative to <base>`).
pub fn rel(base_path: &str, targ_path: &str) -> Result<String, String> {
    os::rel(base_path, targ_path)
}
/// Go `filepath.IsPathSeparator`(`os.IsPathSeparator`).
pub fn is_path_separator(c: u8) -> bool {
    os::is_sep(c)
}

/// Go `filepath.Abs`. unix 는 작업 디렉터리에 잇고, Windows 는 `GetFullPathName` 대신
/// 같은 규칙(작업 디렉터리 + Join)으로 근사한다.
pub fn abs(path: &str) -> io::Result<String> {
    if is_abs(path) {
        return Ok(clean(path));
    }
    let wd = std::env::current_dir()?;
    Ok(join(&[wd.to_string_lossy().as_ref(), path]))
}

/// Go `filepath.EvalSymlinks`. 오류는 Go 와 같은 문구가 되도록 `oserr` 의 PathError 로 싼다
/// (`lstat <경로>: <errno>`). Windows 는 Go 의 대소문자 정규화(`toNorm`)를 하지 않는다.
pub fn eval_symlinks(path: &str) -> io::Result<String> {
    walk_symlinks(path, os::is_sep, os::volume_name_len, os::clean, |p| {
        std::fs::symlink_metadata(p)
    })
}

/// 심링크가 없을 때 [`eval_symlinks`] 가 따르는 조각 규칙을 그대로 쓰는 몸통이다.
fn walk_symlinks(
    path: &str,
    is_sep: fn(u8) -> bool,
    vol_len_of: fn(&str) -> usize,
    clean_fn: fn(&str) -> String,
    lstat: impl Fn(&str) -> io::Result<std::fs::Metadata>,
) -> io::Result<String> {
    use crate::oserr::path_error;
    let sep = if is_sep(b'\\') { "\\" } else { "/" };
    let mut path = path.to_owned();
    let mut vol_len = vol_len_of(&path);
    if vol_len < path.len() && is_sep(path.as_bytes()[vol_len]) {
        vol_len += 1;
    }
    let mut vol = path[..vol_len].to_owned();
    let mut dest = vol.clone();
    let mut links_walked = 0;
    let (mut start, mut end) = (vol_len, vol_len);
    let is_windows = sep == "\\";
    while start < path.len() {
        let b = path.as_bytes();
        while start < b.len() && is_sep(b[start]) {
            start += 1;
        }
        end = start;
        while end < b.len() && !is_sep(b[end]) {
            end += 1;
        }
        let is_windows_dot = is_windows && &path[vol_len_of(&path)..] == ".";
        if end == start {
            break;
        } else if &path[start..end] == "." && !is_windows_dot {
            start = end;
            continue;
        } else if &path[start..end] == ".." {
            let db = dest.as_bytes();
            let mut r = db.len() as isize - 1;
            while r >= vol_len as isize && !is_sep(db[r as usize]) {
                r -= 1;
            }
            if r < vol_len as isize || &dest[(r + 1) as usize..] == ".." {
                if dest.len() > vol_len {
                    dest.push_str(sep);
                }
                dest.push_str("..");
            } else {
                dest.truncate(r as usize);
            }
            start = end;
            continue;
        }
        if dest.len() > vol_len_of(&dest) && !is_sep(dest.as_bytes()[dest.len() - 1]) {
            dest.push_str(sep);
        }
        dest.push_str(&path[start..end]);
        let fi = lstat(&dest).map_err(|e| path_error("lstat", &dest, e))?;
        if !fi.file_type().is_symlink() {
            if !fi.is_dir() && end < path.len() {
                return Err(io::Error::from_raw_os_error(enotdir()));
            }
            start = end;
            continue;
        }
        links_walked += 1;
        if links_walked > 255 {
            return Err(io::Error::other("EvalSymlinks: too many links"));
        }
        let link = std::fs::read_link(&dest)
            .map_err(|e| path_error("readlink", &dest, e))?
            .to_string_lossy()
            .into_owned();
        if is_windows_dot && !is_abs_with(&link, is_sep, vol_len_of) {
            break;
        }
        path = format!("{link}{}", &path[end..]);
        let lb = link.as_bytes();
        let v = vol_len_of(&link);
        if v > 0 {
            let v = if v < lb.len() && is_sep(lb[v]) {
                v + 1
            } else {
                v
            };
            vol = link[..v].to_owned();
            dest = vol.clone();
            end = vol.len();
        } else if !lb.is_empty() && is_sep(lb[0]) {
            dest = link[..1].to_owned();
            end = 1;
            vol = link[..1].to_owned();
            vol_len = 1;
        } else {
            let db = dest.as_bytes();
            let mut r = db.len() as isize - 1;
            while r >= vol_len as isize && !is_sep(db[r as usize]) {
                r -= 1;
            }
            if r < vol_len as isize {
                dest = vol.clone();
            } else {
                dest.truncate(r as usize);
            }
            end = 0;
        }
        start = end;
    }
    let _ = end;
    Ok(clean_fn(&dest))
}

fn is_abs_with(p: &str, is_sep: fn(u8) -> bool, vol_len_of: fn(&str) -> usize) -> bool {
    if is_sep(b'\\') {
        windows::is_abs(p)
    } else {
        let _ = vol_len_of;
        p.as_bytes().first().is_some_and(|&c| is_sep(c))
    }
}

#[cfg(unix)]
fn enotdir() -> i32 {
    20 // ENOTDIR — darwin·linux 공통 값
}
#[cfg(not(unix))]
fn enotdir() -> i32 {
    267 // ERROR_DIRECTORY
}

/// 두 규칙이 함께 쓰는 Clean 몸통이다. `post` 는 Windows 의 postClean 이다.
fn clean_with(
    path: &str,
    sep: u8,
    is_sep: fn(u8) -> bool,
    vol_len: usize,
    windows: bool,
) -> String {
    let original = path;
    let vol = &path[..vol_len];
    let p = &path.as_bytes()[vol_len..];
    let from_slash = |s: String| if windows { s.replace('/', "\\") } else { s };
    if p.is_empty() {
        let ob = original.as_bytes();
        if vol_len > 1 && is_sep(ob[0]) && is_sep(ob[1]) {
            return from_slash(original.to_owned());
        }
        return format!("{original}.");
    }
    let rooted = is_sep(p[0]);
    let n = p.len();
    let mut out: Vec<u8> = Vec::with_capacity(n + 2);
    let (mut r, mut dotdot) = (0, 0);
    if rooted {
        out.push(sep);
        r = 1;
        dotdot = 1;
    }
    while r < n {
        if is_sep(p[r]) || (p[r] == b'.' && (r + 1 == n || is_sep(p[r + 1]))) {
            r += 1;
        } else if p[r] == b'.' && p[r + 1] == b'.' && (r + 2 == n || is_sep(p[r + 2])) {
            r += 2;
            if out.len() > dotdot {
                out.pop();
                while out.len() > dotdot && !is_sep(out[out.len() - 1]) {
                    out.pop();
                }
                if out.len() > dotdot {
                    out.pop();
                }
            } else if !rooted {
                if !out.is_empty() {
                    out.push(sep);
                }
                out.extend_from_slice(b"..");
                dotdot = out.len();
            }
        } else {
            if (rooted && out.len() != 1) || (!rooted && !out.is_empty()) {
                out.push(sep);
            }
            while r < n && !is_sep(p[r]) {
                out.push(p[r]);
                r += 1;
            }
        }
    }
    if out.is_empty() {
        out.push(b'.');
    }
    // postClean (Windows): 볼륨이 없고 버퍼가 원문과 갈렸을 때만 — Go lazybuf 는 원문과
    // 같으면 buf 를 만들지 않는다.
    if windows && vol_len == 0 && out.as_slice() != p {
        let first_sep = out.iter().position(|&c| is_sep(c)).unwrap_or(out.len());
        if out[..first_sep].contains(&b':') {
            out.splice(0..0, [b'.', sep]);
        } else if out.len() >= 3 && is_sep(out[0]) && out[1] == b'?' && out[2] == b'?' {
            out.splice(0..0, [sep, b'.']);
        }
    }
    let body = String::from_utf8(out).unwrap_or_default();
    from_slash(format!("{vol}{body}"))
}

fn ext_with(path: &str, is_sep: fn(u8) -> bool) -> &str {
    let b = path.as_bytes();
    for i in (0..b.len()).rev() {
        if is_sep(b[i]) {
            break;
        }
        if b[i] == b'.' {
            return &path[i..];
        }
    }
    ""
}

fn split_with(path: &str, is_sep: fn(u8) -> bool, vol: usize) -> (&str, &str) {
    let b = path.as_bytes();
    let mut i = b.len();
    while i > vol && !is_sep(b[i - 1]) {
        i -= 1;
    }
    path.split_at(i)
}

fn base_with(
    path: &str,
    sep: char,
    is_sep: fn(u8) -> bool,
    vol_len_of: fn(&str) -> usize,
) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let mut p = path;
    while let Some(&c) = p.as_bytes().last() {
        if !is_sep(c) {
            break;
        }
        p = &p[..p.len() - 1];
    }
    p = &p[vol_len_of(p)..];
    if let Some(i) = p.bytes().rposition(is_sep) {
        p = &p[i + 1..];
    }
    if p.is_empty() {
        return sep.to_string();
    }
    p.to_owned()
}

fn rel_with(
    base_path: &str,
    targ_path: &str,
    sep: u8,
    clean_fn: fn(&str) -> String,
    vol_len_of: fn(&str) -> usize,
    same: fn(&str, &str) -> bool,
) -> Result<String, String> {
    let fail = || format!("Rel: can't make {targ_path} relative to {base_path}");
    let base_vol = &base_path[..vol_len_of(base_path)];
    let targ_vol = &targ_path[..vol_len_of(targ_path)];
    let base_c = clean_fn(base_path);
    let targ_c = clean_fn(targ_path);
    if same(&targ_c, &base_c) {
        return Ok(".".to_owned());
    }
    let mut base = &base_c[base_vol.len()..];
    let targ = &targ_c[targ_vol.len()..];
    let sep_str = (sep as char).to_string();
    if base == "." {
        base = "";
    } else if base.is_empty() && vol_len_of(base_vol) > 2 {
        base = &sep_str;
    }
    let base_slashed = base.as_bytes().first() == Some(&sep);
    let targ_slashed = targ.as_bytes().first() == Some(&sep);
    if base_slashed != targ_slashed || !same(base_vol, targ_vol) {
        return Err(fail());
    }
    let (bb, tb) = (base.as_bytes(), targ.as_bytes());
    let (bl, tl) = (bb.len(), tb.len());
    let (mut b0, mut bi, mut t0, mut ti) = (0, 0, 0, 0);
    loop {
        while bi < bl && bb[bi] != sep {
            bi += 1;
        }
        while ti < tl && tb[ti] != sep {
            ti += 1;
        }
        if !same(&targ[t0..ti], &base[b0..bi]) {
            break;
        }
        if bi < bl {
            bi += 1;
        }
        if ti < tl {
            ti += 1;
        }
        b0 = bi;
        t0 = ti;
    }
    if &base[b0..bi] == ".." {
        return Err(fail());
    }
    if b0 != bl {
        let seps = bb[b0..bl].iter().filter(|&&c| c == sep).count();
        let mut buf = String::from("..");
        for _ in 0..seps {
            buf.push(sep as char);
            buf.push_str("..");
        }
        if t0 != tl {
            buf.push(sep as char);
            buf.push_str(&targ[t0..]);
        }
        return Ok(clean_fn(&buf));
    }
    Ok(targ[t0..].to_owned())
}

/// unix 규칙이다.
pub mod unix {
    pub const SEPARATOR: char = '/';
    pub const LIST_SEPARATOR: char = ':';

    pub fn is_sep(c: u8) -> bool {
        c == b'/'
    }
    pub fn volume_name_len(_: &str) -> usize {
        0
    }
    pub fn clean(path: &str) -> String {
        super::clean_with(path, b'/', is_sep, 0, false)
    }
    pub fn join<S: AsRef<str>>(elem: &[S]) -> String {
        match elem.iter().position(|e| !e.as_ref().is_empty()) {
            Some(i) => clean(
                &elem[i..]
                    .iter()
                    .map(|e| e.as_ref())
                    .collect::<Vec<_>>()
                    .join("/"),
            ),
            None => String::new(),
        }
    }
    pub fn is_abs(path: &str) -> bool {
        path.starts_with('/')
    }
    pub fn volume_name(_: &str) -> String {
        String::new()
    }
    pub fn to_slash(path: &str) -> String {
        path.to_owned()
    }
    pub fn from_slash(path: &str) -> String {
        path.to_owned()
    }
    pub fn dir(path: &str) -> String {
        clean(split(path).0)
    }
    pub fn base(path: &str) -> String {
        super::base_with(path, '/', is_sep, volume_name_len)
    }
    pub fn ext(path: &str) -> &str {
        super::ext_with(path, is_sep)
    }
    pub fn split(path: &str) -> (&str, &str) {
        super::split_with(path, is_sep, 0)
    }
    pub fn split_list(path: &str) -> Vec<String> {
        if path.is_empty() {
            return Vec::new();
        }
        path.split(':').map(str::to_owned).collect()
    }
    pub fn rel(base: &str, targ: &str) -> Result<String, String> {
        super::rel_with(base, targ, b'/', clean, volume_name_len, |a, b| a == b)
    }
}

/// Windows 규칙이다. `/` 와 `\` 를 모두 구분자로 본다.
pub mod windows {
    pub const SEPARATOR: char = '\\';
    pub const LIST_SEPARATOR: char = ';';

    pub fn is_sep(c: u8) -> bool {
        c == b'\\' || c == b'/'
    }

    fn upper(c: u8) -> u8 {
        c.to_ascii_uppercase()
    }

    fn has_prefix_fold(s: &[u8], prefix: &[u8]) -> bool {
        if s.len() < prefix.len() {
            return false;
        }
        for (i, &p) in prefix.iter().enumerate() {
            if is_sep(p) {
                if !is_sep(s[i]) {
                    return false;
                }
            } else if upper(p) != upper(s[i]) {
                return false;
            }
        }
        s.len() <= prefix.len() || is_sep(s[prefix.len()])
    }

    fn unc_len(p: &[u8], prefix_len: usize) -> usize {
        let mut count = 0;
        for (i, &c) in p.iter().enumerate().skip(prefix_len) {
            if is_sep(c) {
                count += 1;
                if count == 2 {
                    return i;
                }
            }
        }
        p.len()
    }

    fn cut_path(p: &[u8]) -> (&[u8], &[u8], bool) {
        match p.iter().position(|&c| is_sep(c)) {
            Some(i) => (&p[..i], &p[i + 1..], true),
            None => (p, &[], false),
        }
    }

    fn valid_volume_name_len(p: &[u8], n: usize) -> usize {
        let mut rest = &p[..n];
        while !rest.is_empty() {
            let (part, after, _) = cut_path(rest);
            if part == b".." {
                return 0;
            }
            rest = after;
        }
        n
    }

    pub fn volume_name_len(path: &str) -> usize {
        let p = path.as_bytes();
        if p.len() >= 2 && p[1] == b':' {
            return 2;
        }
        if p.is_empty() || !is_sep(p[0]) {
            return 0;
        }
        if has_prefix_fold(p, b"\\\\.")
            || has_prefix_fold(p, b"\\\\?")
            || has_prefix_fold(p, b"\\??")
        {
            if p.len() == 3 {
                return 3;
            }
            if has_prefix_fold(&p[4..], b"UNC") {
                return valid_volume_name_len(p, unc_len(p, "\\\\.\\UNC\\".len()));
            }
            let (_, rest, ok) = cut_path(&p[4..]);
            if !ok {
                return valid_volume_name_len(p, p.len());
            }
            return valid_volume_name_len(p, p.len() - rest.len() - 1);
        }
        if p.len() >= 2 && is_sep(p[1]) {
            return valid_volume_name_len(p, unc_len(p, 2));
        }
        0
    }

    pub fn clean(path: &str) -> String {
        super::clean_with(path, b'\\', is_sep, volume_name_len(path), true)
    }

    pub fn is_abs(path: &str) -> bool {
        let l = volume_name_len(path);
        if l == 0 {
            return false;
        }
        let p = path.as_bytes();
        if is_sep(p[0]) && is_sep(p[1]) {
            return true;
        }
        p.get(l).is_some_and(|&c| is_sep(c))
    }

    pub fn volume_name(path: &str) -> String {
        from_slash(&path[..volume_name_len(path)])
    }
    pub fn to_slash(path: &str) -> String {
        path.replace('\\', "/")
    }
    pub fn from_slash(path: &str) -> String {
        path.replace('/', "\\")
    }

    pub fn join<S: AsRef<str>>(elem: &[S]) -> String {
        let mut b = String::new();
        let mut last: u8 = 0;
        for e in elem {
            let mut e = e.as_ref();
            if b.is_empty() {
            } else if is_sep(last) {
                while e.as_bytes().first().is_some_and(|&c| is_sep(c)) {
                    e = &e[1..];
                }
                if b.len() == 1 && e.starts_with("??") && (e.len() == 2 || is_sep(e.as_bytes()[2]))
                {
                    b.push_str(".\\");
                }
            } else if last == b':' {
            } else {
                b.push('\\');
                last = b'\\';
            }
            if let Some(&c) = e.as_bytes().last() {
                b.push_str(e);
                last = c;
            }
        }
        if b.is_empty() {
            return String::new();
        }
        clean(&b)
    }

    pub fn dir(path: &str) -> String {
        let vol = &path[..volume_name_len(path)];
        let b = path.as_bytes();
        let mut i = b.len();
        while i > vol.len() && !is_sep(b[i - 1]) {
            i -= 1;
        }
        let d = clean(&path[vol.len()..i]);
        if d == "." && vol.len() > 2 {
            return from_slash(vol);
        }
        format!("{}{d}", from_slash(vol))
    }

    pub fn base(path: &str) -> String {
        super::base_with(path, '\\', is_sep, volume_name_len)
    }
    pub fn ext(path: &str) -> &str {
        super::ext_with(path, is_sep)
    }
    pub fn split(path: &str) -> (&str, &str) {
        super::split_with(path, is_sep, volume_name_len(path))
    }

    pub fn split_list(path: &str) -> Vec<String> {
        if path.is_empty() {
            return Vec::new();
        }
        let b = path.as_bytes();
        let mut list = Vec::new();
        let (mut start, mut quo) = (0, false);
        for (i, &c) in b.iter().enumerate() {
            if c == b'"' {
                quo = !quo;
            } else if c == b';' && !quo {
                list.push(&path[start..i]);
                start = i + 1;
            }
        }
        list.push(&path[start..]);
        list.into_iter().map(|s| s.replace('"', "")).collect()
    }

    fn same_word(a: &str, b: &str) -> bool {
        // Go strings.EqualFold: 유니코드 단순 대소문자 접기.
        a.chars().count() == b.chars().count()
            && a.chars()
                .zip(b.chars())
                .all(|(x, y)| x == y || x.to_lowercase().eq(y.to_lowercase()))
    }

    pub fn rel(base: &str, targ: &str) -> Result<String, String> {
        super::rel_with(base, targ, b'\\', clean, volume_name_len, same_word)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::type_complexity)]
    use super::*;

    // go1.27.2 실측(unix)과 Go 자체 시험 표(path_test.go 의 win*tests)에서 옮긴 기대값이다.

    const CASES: &[(
        &str,
        &str,
        &str,
        &str,
        &str,
        &str,
        &str,
        &str,
        &str,
        &str,
        &str,
        bool,
    )] = &[
        ("", ".", ".", ".", "", "", "", ".", ".", ".", "|", false),
        (".", ".", ".", ".", ".", "", ".", ".", ".", ".", "|.", false),
        (
            "..", "..", ".", "..", ".", "", "..", "..", ".", "..", "|..", false,
        ),
        ("/", "/", "/", "/", "", "/", "", "/", "/", "/", "/|", true),
        (
            "//", "/", "/", "/", "", "//", "", "/", "/", "/", "//|", true,
        ),
        (
            "///a//b/",
            "/a/b",
            "/a/b",
            "b",
            "",
            "///a//b/",
            "",
            "/a/b",
            "/a/b",
            "b",
            "///a//b/|",
            true,
        ),
        ("a", "a", ".", "a", "", "", "a", "a", ".", "a", "|a", false),
        (
            "a/", "a", "a", "a", "", "a/", "", "a", "a", "a", "a/|", false,
        ),
        (
            "/a", "/a", "/", "a", "", "/", "a", "/a", "/", "a", "/|a", true,
        ),
        (
            "a/b", "a/b", "a", "b", "", "a/", "b", "a/b", "a", "b", "a/|b", false,
        ),
        (
            "a/b/", "a/b", "a/b", "b", "", "a/b/", "", "a/b", "a/b", "b", "a/b/|", false,
        ),
        (
            "a/./b", "a/b", "a", "b", "", "a/./", "b", "a/b", "a", "b", "a/./|b", false,
        ),
        (
            "a/../b", "b", ".", "b", "", "a/../", "b", "b", ".", "b", "a/../|b", false,
        ),
        (
            "../a", "../a", "..", "a", "", "../", "a", "../a", "..", "a", "../|a", false,
        ),
        (
            "../../a/..",
            "../..",
            "../../a",
            "..",
            ".",
            "../../a/",
            "..",
            "../..",
            "../../a",
            "..",
            "../../a/|..",
            false,
        ),
        (
            "/../a", "/a", "/", "a", "", "/../", "a", "/a", "/", "a", "/../|a", true,
        ),
        (
            "/a/b/../../..",
            "/",
            "/",
            "..",
            ".",
            "/a/b/../../",
            "..",
            "/",
            "/",
            "..",
            "/a/b/../../|..",
            true,
        ),
        (
            "a/b/c/../../d",
            "a/d",
            "a",
            "d",
            "",
            "a/b/c/../../",
            "d",
            "a/d",
            "a",
            "d",
            "a/b/c/../../|d",
            false,
        ),
        (
            "./", ".", ".", ".", "", "./", "", ".", ".", ".", "./|", false,
        ),
        (
            "./a", "a", ".", "a", "", "./", "a", "a", ".", "a", "./|a", false,
        ),
        (
            "a//b", "a/b", "a", "b", "", "a//", "b", "a/b", "a", "b", "a//|b", false,
        ),
        (
            "abc/def/.ghi",
            "abc/def/.ghi",
            "abc/def",
            ".ghi",
            ".ghi",
            "abc/def/",
            ".ghi",
            "abc/def/.ghi",
            "abc/def",
            ".ghi",
            "abc/def/|.ghi",
            false,
        ),
        (
            "x.tar.gz",
            "x.tar.gz",
            ".",
            "x.tar.gz",
            ".gz",
            "",
            "x.tar.gz",
            "x.tar.gz",
            ".",
            "x.tar.gz",
            "|x.tar.gz",
            false,
        ),
        (
            "/x/.y", "/x/.y", "/x", ".y", ".y", "/x/", ".y", "/x/.y", "/x", ".y", "/x/|.y", true,
        ),
        (
            "a/b.c/d", "a/b.c/d", "a/b.c", "d", "", "a/b.c/", "d", "a/b.c/d", "a/b.c", "d",
            "a/b.c/|d", false,
        ),
        (
            "..a", "..a", ".", "..a", ".a", "", "..a", "..a", ".", "..a", "|..a", false,
        ),
        (
            "a..", "a..", ".", "a..", ".", "", "a..", "a..", ".", "a..", "|a..", false,
        ),
        (
            "/a/b/c/", "/a/b/c", "/a/b/c", "c", "", "/a/b/c/", "", "/a/b/c", "/a/b/c", "c",
            "/a/b/c/|", true,
        ),
        (
            "a\\b", "a\\b", ".", "a\\b", "", "", "a\\b", "a\\b", ".", "a\\b", "|a\\b", false,
        ),
        (
            "C:\\x", "C:\\x", ".", "C:\\x", "", "", "C:\\x", "C:\\x", ".", "C:\\x", "|C:\\x", false,
        ),
        (
            "/tmp/repo/sub/..",
            "/tmp/repo",
            "/tmp/repo/sub",
            "..",
            ".",
            "/tmp/repo/sub/",
            "..",
            "/tmp/repo",
            "/tmp/repo/sub",
            "..",
            "/tmp/repo/sub/|..",
            true,
        ),
        (
            "/Users/x/repo/",
            "/Users/x/repo",
            "/Users/x/repo",
            "repo",
            "",
            "/Users/x/repo/",
            "",
            "/Users/x/repo",
            "/Users/x/repo",
            "repo",
            "/Users/x/repo/|",
            true,
        ),
        (
            "ab/..", ".", "ab", "..", ".", "ab/", "..", ".", "ab", "..", "ab/|..", false,
        ),
        (
            "a/../..", "..", ".", "..", ".", "a/../", "..", "..", ".", "..", "a/../|..", false,
        ),
        (
            "....", "....", ".", "....", ".", "", "....", "....", ".", "....", "|....", false,
        ),
        (
            "a/b/../c/./d/",
            "a/c/d",
            "a/c/d",
            "d",
            "",
            "a/b/../c/./d/",
            "",
            "a/c/d",
            "a/c/d",
            "d",
            "a/b/../c/./d/|",
            false,
        ),
    ];
    const JOINS: &[(&[&str], &str, &str)] = &[
        (&[], "", ""),
        (&[""], "", ""),
        (&["", ""], "", ""),
        (&["a"], "a", "a"),
        (&["a", "b"], "a/b", "a/b"),
        (&["a", ""], "a", "a"),
        (&["", "b"], "b", "b"),
        (&["/", "a"], "/a", "/a"),
        (&["/", ""], "/", "/"),
        (&["a/", "b"], "a/b", "a/b"),
        (&["a", "/b"], "a/b", "a/b"),
        (&["a", "../b"], "b", "b"),
        (&["", "", "a"], "a", "a"),
        (&["/a", "..", "..", "b"], "/b", "/b"),
    ];
    const RELS: &[(&str, &str, &str)] = &[
        ("a/b", "a/b", "."),
        ("a/b/.", "a/b", "."),
        ("a/b", "a/b/.", "."),
        ("./a/b", "a/b", "."),
        ("a/b", "a/b/c", "c"),
        ("a/b/c", "a/b", ".."),
        ("a/b", "c/d", "../../c/d"),
        ("/a/b", "/a/b/c/d", "c/d"),
        ("/a/b", "/c/d", "../../c/d"),
        ("/", "/a/b", "a/b"),
        (".", "a/b", "a/b"),
        (".", "..", ".."),
        ("..", "a", "ERR:Rel: can't make a relative to .."),
        ("/a", "b", "ERR:Rel: can't make b relative to /a"),
        ("a", "/b", "ERR:Rel: can't make /b relative to a"),
        ("../..", "a", "ERR:Rel: can't make a relative to ../.."),
        ("a/b/c", "a/x/y", "../../x/y"),
        ("/ab/cd", "/ab/cde", "../cde"),
    ];
    const WIN_CLEAN: &[(&str, &str)] = &[
        ("c:", "c:."),
        ("c:\\", "c:\\"),
        ("c:\\abc", "c:\\abc"),
        ("c:abc\\..\\..\\.\\.\\..\\def", "c:..\\..\\def"),
        ("c:\\abc\\def\\..\\..", "c:\\"),
        ("c:\\..\\abc", "c:\\abc"),
        ("c:..\\abc", "c:..\\abc"),
        ("c:\\b:\\..\\..\\..\\d", "c:\\d"),
        ("\\", "\\"),
        ("/", "\\"),
        ("\\\\i\\..\\c$", "\\c$"),
        ("\\\\i\\..\\i\\c$", "\\i\\c$"),
        ("\\\\i\\..\\I\\c$", "\\I\\c$"),
        ("\\\\..\\..\\a", "\\a"),
        ("\\\\host\\share\\foo\\..\\bar", "\\\\host\\share\\bar"),
        (
            "\\\\host\\share\\foo\\..\\..\\..\\..\\bar",
            "\\\\host\\share\\bar",
        ),
        (
            "\\\\?\\UNC\\host\\share\\foo\\..\\..\\..\\..\\bar",
            "\\\\?\\UNC\\host\\share\\bar",
        ),
        (
            "\\??\\UNC\\host\\share\\foo\\..\\..\\..\\..\\bar",
            "\\??\\UNC\\host\\share\\bar",
        ),
        ("\\\\.\\C:\\a\\..\\..\\..\\..\\bar", "\\\\.\\C:\\bar"),
        ("\\\\.\\C:\\\\\\\\a", "\\\\.\\C:\\a"),
        ("\\\\a\\b\\..\\c", "\\\\a\\b\\c"),
        ("\\\\a\\b", "\\\\a\\b"),
        (".\\c:", ".\\c:"),
        (".\\c:\\foo", ".\\c:\\foo"),
        (".\\c:foo", ".\\c:foo"),
        ("\\\\?\\C:\\", "\\\\?\\C:\\"),
        ("\\\\?\\C:\\a", "\\\\?\\C:\\a"),
        ("a/../c:", ".\\c:"),
        ("a\\..\\c:", ".\\c:"),
        ("a/../c:/a", ".\\c:\\a"),
        ("a/../../c:", "..\\c:"),
        ("foo:bar", "foo:bar"),
        ("/a/../??/a", "\\.\\??\\a"),
    ];
    const WIN_SPLIT: &[(&str, &str, &str)] = &[
        ("c:", "c:", ""),
        ("c:/", "c:/", ""),
        ("c:/foo", "c:/", "foo"),
        ("c:/foo/bar", "c:/foo/", "bar"),
        ("\\\\host\\share", "\\\\host\\share", ""),
        ("\\\\host\\share\\", "\\\\host\\share\\", ""),
        ("\\\\host\\share\\foo", "\\\\host\\share\\", "foo"),
    ];
    const WIN_BASE: &[(&str, &str)] = &[
        ("c:\\", "\\"),
        ("c:.", "."),
        ("c:\\a\\b", "b"),
        ("c:a\\b", "b"),
        ("c:a\\b\\c", "c"),
        ("\\\\host\\share\\", "\\"),
        ("\\\\host\\share\\a", "a"),
        ("\\\\host\\share\\a\\b", "b"),
    ];
    const WIN_DIR: &[(&str, &str)] = &[
        ("c:\\", "c:\\"),
        ("c:.", "c:."),
        ("c:\\a\\b", "c:\\a"),
        ("c:a\\b", "c:a"),
        ("c:a\\b\\c", "c:a\\b"),
        ("\\\\host\\share", "\\\\host\\share"),
        ("\\\\host\\share\\", "\\\\host\\share\\"),
        ("\\\\host\\share\\a", "\\\\host\\share\\"),
        ("\\\\host\\share\\a\\b", "\\\\host\\share\\a"),
        ("\\\\\\\\", "\\\\\\\\"),
    ];
    const WIN_REL: &[(&str, &str, &str)] = &[
        ("C:a\\b\\c", "C:a/b/d", "..\\d"),
        ("C:\\", "D:\\", "err"),
        ("C:", "D:", "err"),
        ("C:\\Projects", "c:\\projects\\src", "src"),
        ("C:\\Projects", "c:\\projects", "."),
        ("C:\\Projects\\a\\..", "c:\\projects", "."),
        ("\\\\host\\share", "\\\\host\\share\\file.txt", "file.txt"),
    ];
    const WIN_VOLUME: &[(&str, &str)] = &[
        ("c:/foo/bar", "c:"),
        ("c:", "c:"),
        ("c:\\", "c:"),
        ("2:", "2:"),
        ("", ""),
        ("\\\\\\host", "\\\\\\host"),
        ("\\\\\\host\\", "\\\\\\host"),
        ("\\\\\\host\\share", "\\\\\\host"),
        ("\\\\\\host\\\\share", "\\\\\\host"),
        ("\\\\host", "\\\\host"),
        ("\\\\host\\", "\\\\host\\"),
        ("\\\\host\\share", "\\\\host\\share"),
        ("\\\\host\\share\\", "\\\\host\\share"),
        ("\\\\host\\share\\foo", "\\\\host\\share"),
        (
            "\\\\host\\share\\\\foo\\\\\\bar\\\\\\\\baz",
            "\\\\host\\share",
        ),
        ("\\\\host\\share\\foo\\..\\bar", "\\\\host\\share"),
        ("\\\\..\\..\\a", ""),
        ("\\\\i\\..\\c$", ""),
        ("/??", "\\??"),
        ("/??/", "\\??\\"),
        ("/??/NUL", "\\??\\NUL"),
        ("/??/UNC/host/share/a/b/c", "\\??\\UNC\\host\\share"),
        ("\\\\?\\x", "\\\\?\\x"),
        ("\\??\\x", "\\??\\x"),
    ];
    const WIN_ISABS: &[(&str, bool)] = &[
        ("C:\\", true),
        ("c\\", false),
        ("c::", false),
        ("c:", false),
        ("/", false),
        ("\\", false),
        ("\\Windows", false),
        ("c:a\\b", false),
        ("c:\\a\\b", true),
        ("c:/a/b", true),
        ("\\\\host\\share", true),
        ("\\\\host\\share\\", true),
        ("\\\\host\\share\\foo", true),
        ("\\\\..\\..\\a", false),
        ("\\\\i\\..\\c$", false),
        ("\\\\?\\a\\b\\c", true),
        ("\\??\\a\\b\\c", true),
    ];
    const WIN_JOIN: &[(&[&str], &str)] = &[
        (&["directory", "file"], "directory\\file"),
        (&["C:\\Windows\\", "System32"], "C:\\Windows\\System32"),
        (&["C:\\Windows\\", ""], "C:\\Windows"),
        (&["C:\\", "Windows"], "C:\\Windows"),
        (&["C:", "a"], "C:a"),
        (&["C:", "a\\b"], "C:a\\b"),
        (&["C:", "a", "b"], "C:a\\b"),
        (&["C:", "", "b"], "C:b"),
        (&["C:", "", "", "b"], "C:b"),
        (&["C:", ""], "C:."),
        (&["C:", "", ""], "C:."),
        (&["C:", "\\a"], "C:\\a"),
        (&["C:", "", "\\a"], "C:\\a"),
        (&["C:.", "a"], "C:a"),
        (&["C:a", "b"], "C:a\\b"),
        (&["C:a", "b", "d"], "C:a\\b\\d"),
        (&["\\\\host\\share", "foo"], "\\\\host\\share\\foo"),
        (&["\\\\host\\share\\foo"], "\\\\host\\share\\foo"),
        (&["\\"], "\\"),
        (&["\\", ""], "\\"),
        (&["\\", "a"], "\\a"),
        (&["\\\\", "a"], "\\\\a"),
        (&["\\", "a", "b"], "\\a\\b"),
        (&["\\\\", "a", "b"], "\\\\a\\b"),
        (&["\\", "\\\\a\\b", "c"], "\\a\\b\\c"),
        (&["\\\\a", "b", "c"], "\\\\a\\b\\c"),
        (&["\\\\a\\", "b", "c"], "\\\\a\\b\\c"),
        (&["a:\\b\\c", "x\\..\\y:\\..\\..\\z"], "a:\\b\\z"),
        (&["\\", "??\\a"], "\\.\\??\\a"),
    ];
    const WIN_SPLITLIST: &[(&str, &[&str])] = &[
        ("\"a\"", &["a"]),
        ("\";\"", &[";"]),
        ("\"a;b\"", &["a;b"]),
        ("\";\";", &[";", ""]),
        (";\";\"", &["", ";"]),
        ("a\";\"b", &["a;b"]),
        ("a; \"\"b", &["a", " b"]),
        ("\"a;b", &["a;b"]),
        ("\"\"a;b", &["a", "b"]),
        ("\"\"\"a;b", &["a;b"]),
        ("\"\"\"\"a;b", &["a", "b"]),
        ("a\";b", &["a;b"]),
        ("a;b\";c", &["a", "b;c"]),
        ("\"a\";b\";c", &["a", "b;c"]),
    ];

    #[test]
    fn unix_rules_match_go() {
        for &(s, cl, d, b, e, sd, sf, pc, pd, pb, ps, abs) in CASES {
            assert_eq!(unix::clean(s), cl, "Clean({s:?})");
            assert_eq!(unix::dir(s), d, "Dir({s:?})");
            assert_eq!(unix::base(s), b, "Base({s:?})");
            assert_eq!(unix::ext(s), e, "Ext({s:?})");
            assert_eq!(unix::split(s), (sd, sf), "Split({s:?})");
            assert_eq!(unix::is_abs(s), abs, "IsAbs({s:?})");
            assert_eq!(crate::path::clean(s), pc, "path.Clean({s:?})");
            assert_eq!(crate::path::dir(s), pd, "path.Dir({s:?})");
            assert_eq!(crate::path::base(s), pb, "path.Base({s:?})");
            let (a, z) = crate::path::split(s);
            assert_eq!(format!("{a}|{z}"), ps, "path.Split({s:?})");
            assert_eq!(crate::path::is_abs(s), abs, "path.IsAbs({s:?})");
        }
        for &(elem, fj, pj) in JOINS {
            assert_eq!(unix::join(elem), fj, "Join({elem:?})");
            assert_eq!(crate::path::join(elem), pj, "path.Join({elem:?})");
        }
        for &(b, t, want) in RELS {
            let got = unix::rel(b, t).unwrap_or_else(|e| format!("ERR:{e}"));
            assert_eq!(got, want, "Rel({b:?}, {t:?})");
        }
        assert!(unix::split_list("").is_empty());
        assert_eq!(unix::split_list(":a:"), ["", "a", ""]);
        assert_eq!(unix::split_list("a::b"), ["a", "", "b"]);
    }

    #[test]
    fn windows_rules_match_go() {
        for &(s, want) in WIN_CLEAN {
            assert_eq!(windows::clean(s), want, "Clean({s:?})");
        }
        for &(s, d, f) in WIN_SPLIT {
            assert_eq!(windows::split(s), (d, f), "Split({s:?})");
        }
        for &(s, want) in WIN_BASE {
            assert_eq!(windows::base(s), want, "Base({s:?})");
        }
        for &(s, want) in WIN_DIR {
            assert_eq!(windows::dir(s), want, "Dir({s:?})");
        }
        for &(b, t, want) in WIN_REL {
            match windows::rel(b, t) {
                Ok(got) => assert_eq!(got, want, "Rel({b:?}, {t:?})"),
                Err(_) => assert_eq!(want, "err", "Rel({b:?}, {t:?})"),
            }
        }
        for &(s, want) in WIN_VOLUME {
            assert_eq!(
                windows::volume_name(s),
                want.replace('/', "\\"),
                "VolumeName({s:?})"
            );
        }
        for &(s, want) in WIN_ISABS {
            assert_eq!(windows::is_abs(s), want, "IsAbs({s:?})");
        }
        for &(elem, want) in WIN_JOIN {
            assert_eq!(windows::join(elem), want, "Join({elem:?})");
        }
        for &(s, want) in WIN_SPLITLIST {
            assert_eq!(windows::split_list(s), want, "SplitList({s:?})");
        }
    }

    #[cfg(unix)]
    #[test]
    fn eval_symlinks_resolves_prefix_and_reports_go_errors() {
        let root = std::env::temp_dir().join(format!("otter-gocompat-fp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("real/sub")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
        let r = root.to_string_lossy().into_owned();
        let real = eval_symlinks(&format!("{r}/real")).unwrap();
        assert_eq!(
            eval_symlinks(&format!("{r}/link/sub")).unwrap(),
            format!("{real}/sub")
        );
        assert_eq!(eval_symlinks(&format!("{r}/link/./sub/..")).unwrap(), real);
        let err = eval_symlinks(&format!("{r}/link/gone")).unwrap_err();
        assert_eq!(
            crate::oserr::go_error_string(&err),
            format!("lstat {real}/gone: no such file or directory")
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
