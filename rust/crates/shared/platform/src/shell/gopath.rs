//! Go `path/filepath` 의 Join·Clean·Base·IsAbs·SplitList (go1.27.2).
//!
//! 셸 훅 경로와 브라우저 설치 경로가 이 함수들의 결과로 정해지므로, 바이트 단위로 Go 와 같아야
//! 한다. Go 는 호스트 규약을 쓰므로 실제 호출은 [`Conv::HOST`] 로 한다. 두 규약을 모두 두는
//! 이유는 어느 호스트에서도 양쪽을 검사하기 위해서다.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Conv {
    Unix,
    Windows,
}

impl Conv {
    pub(crate) const HOST: Conv = if cfg!(windows) {
        Conv::Windows
    } else {
        Conv::Unix
    };

    fn is_sep(self, c: u8) -> bool {
        match self {
            Conv::Unix => c == b'/',
            Conv::Windows => c == b'/' || c == b'\\',
        }
    }

    fn sep(self) -> u8 {
        match self {
            Conv::Unix => b'/',
            Conv::Windows => b'\\',
        }
    }

    fn list_sep(self) -> u8 {
        match self {
            Conv::Unix => b':',
            Conv::Windows => b';',
        }
    }

    fn volume_name_len(self, p: &[u8]) -> usize {
        match self {
            Conv::Unix => 0,
            Conv::Windows => win_volume_name_len(p),
        }
    }

    fn localize_seps(self, mut v: Vec<u8>) -> String {
        if self == Conv::Windows {
            for c in &mut v {
                if *c == b'/' {
                    *c = b'\\';
                }
            }
        }
        bytes_to_string(v)
    }

    /// `filepath.Clean`.
    pub(crate) fn clean(self, path: &str) -> String {
        let orig = path.as_bytes();
        let vol_len = self.volume_name_len(orig);
        let p = &orig[vol_len..];
        if p.is_empty() {
            if vol_len > 1 && self.is_sep(orig[0]) && self.is_sep(orig[1]) {
                return self.localize_seps(orig.to_vec());
            }
            let mut v = orig.to_vec();
            v.push(b'.');
            return bytes_to_string(v);
        }
        let rooted = self.is_sep(p[0]);
        let n = p.len();
        let sep = self.sep();
        let mut out = LazyBuf {
            path: p,
            buf: None,
            w: 0,
        };
        let (mut r, mut dotdot) = (0, 0);
        if rooted {
            out.append(sep);
            r = 1;
            dotdot = 1;
        }
        while r < n {
            // 빈 원소와 `.` 원소는 건너뛴다.
            if self.is_sep(p[r]) || (p[r] == b'.' && (r + 1 == n || self.is_sep(p[r + 1]))) {
                r += 1;
            } else if p[r] == b'.' && p[r + 1] == b'.' && (r + 2 == n || self.is_sep(p[r + 2])) {
                r += 2;
                if out.w > dotdot {
                    out.w -= 1;
                    while out.w > dotdot && !self.is_sep(out.index(out.w)) {
                        out.w -= 1;
                    }
                } else if !rooted {
                    if out.w > 0 {
                        out.append(sep);
                    }
                    out.append(b'.');
                    out.append(b'.');
                    dotdot = out.w;
                }
            } else {
                if (rooted && out.w != 1) || (!rooted && out.w != 0) {
                    out.append(sep);
                }
                while r < n && !self.is_sep(p[r]) {
                    out.append(p[r]);
                    r += 1;
                }
            }
        }
        if out.w == 0 {
            out.append(b'.');
        }
        if self == Conv::Windows && vol_len == 0 {
            win_post_clean(&mut out);
        }
        let mut v = orig[..vol_len].to_vec();
        match &out.buf {
            Some(b) => v.extend_from_slice(&b[..out.w]),
            None => v.extend_from_slice(&p[..out.w]),
        }
        self.localize_seps(v)
    }

    /// `filepath.Join`.
    pub(crate) fn join(self, elems: &[&str]) -> String {
        match self {
            Conv::Unix => match elems.iter().position(|e| !e.is_empty()) {
                Some(i) => self.clean(&elems[i..].join("/")),
                None => String::new(),
            },
            Conv::Windows => {
                let mut b: Vec<u8> = Vec::new();
                let mut last: u8 = 0;
                for e in elems {
                    let mut e = e.as_bytes();
                    if b.is_empty() {
                    } else if self.is_sep(last) {
                        while let Some((&c, rest)) = e.split_first() {
                            if !self.is_sep(c) {
                                break;
                            }
                            e = rest;
                        }
                        if b.len() == 1
                            && e.starts_with(b"??")
                            && (e.len() == 2 || self.is_sep(e[2]))
                        {
                            b.extend_from_slice(b".\\");
                        }
                    } else if last == b':' {
                    } else {
                        b.push(b'\\');
                        last = b'\\';
                    }
                    if let Some(&c) = e.last() {
                        b.extend_from_slice(e);
                        last = c;
                    }
                }
                if b.is_empty() {
                    return String::new();
                }
                self.clean(&bytes_to_string(b))
            }
        }
    }

    /// `filepath.Base`.
    pub(crate) fn base(self, path: &str) -> String {
        if path.is_empty() {
            return ".".to_owned();
        }
        let mut p = path.as_bytes();
        while let Some((&c, rest)) = p.split_last() {
            if !self.is_sep(c) {
                break;
            }
            p = rest;
        }
        p = &p[self.volume_name_len(p)..];
        if let Some(i) = p.iter().rposition(|&c| self.is_sep(c)) {
            p = &p[i + 1..];
        }
        if p.is_empty() {
            return char::from(self.sep()).to_string();
        }
        bytes_to_string(p.to_vec())
    }

    /// `filepath.IsAbs`.
    pub(crate) fn is_abs(self, path: &str) -> bool {
        let p = path.as_bytes();
        match self {
            Conv::Unix => p.first() == Some(&b'/'),
            Conv::Windows => {
                let l = win_volume_name_len(p);
                if l == 0 {
                    return false;
                }
                if self.is_sep(p[0]) && self.is_sep(p[1]) {
                    return true;
                }
                p.get(l).is_some_and(|&c| self.is_sep(c))
            }
        }
    }

    /// `filepath.SplitList`. Windows 는 큰따옴표 안의 `;` 를 나누지 않고, 따옴표는 지운다.
    pub(crate) fn split_list(self, path: &str) -> Vec<String> {
        if path.is_empty() {
            return Vec::new();
        }
        let ls = char::from(self.list_sep());
        match self {
            Conv::Unix => path.split(ls).map(str::to_owned).collect(),
            Conv::Windows => {
                let mut list = Vec::new();
                let mut start = 0;
                let mut quo = false;
                for (i, c) in path.bytes().enumerate() {
                    if c == b'"' {
                        quo = !quo;
                    } else if c == self.list_sep() && !quo {
                        list.push(path[start..i].replace('"', ""));
                        start = i + 1;
                    }
                }
                list.push(path[start..].replace('"', ""));
                list
            }
        }
    }
}

fn bytes_to_string(v: Vec<u8>) -> String {
    match String::from_utf8(v) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    }
}

/// Go `lazybuf`. 입력과 갈라지기 전까지는 쓰지 않는다 — Windows postClean 이 "갈라졌는가"와
/// 버퍼 전체(쓰인 길이 너머 포함)를 보므로 모양까지 같게 둔다.
struct LazyBuf<'a> {
    path: &'a [u8],
    buf: Option<Vec<u8>>,
    w: usize,
}

impl LazyBuf<'_> {
    fn index(&self, i: usize) -> u8 {
        match &self.buf {
            Some(b) => b[i],
            None => self.path[i],
        }
    }

    fn append(&mut self, c: u8) {
        let buf = match &mut self.buf {
            Some(b) => b,
            None => {
                if self.w < self.path.len() && self.path[self.w] == c {
                    self.w += 1;
                    return;
                }
                let mut b = vec![0; self.path.len()];
                b[..self.w].copy_from_slice(&self.path[..self.w]);
                self.buf.insert(b)
            }
        };
        buf[self.w] = c;
        self.w += 1;
    }

    fn prepend(&mut self, prefix: &[u8]) {
        let buf = self.buf.get_or_insert_with(Vec::new);
        buf.splice(0..0, prefix.iter().copied());
        self.w += prefix.len();
    }
}

fn win_is_sep(c: u8) -> bool {
    c == b'/' || c == b'\\'
}

fn win_post_clean(out: &mut LazyBuf<'_>) {
    let Some(buf) = &out.buf else {
        return;
    };
    let colon_first = buf
        .iter()
        .take_while(|&&c| !win_is_sep(c))
        .any(|&c| c == b':');
    if colon_first {
        out.prepend(b".\\");
        return;
    }
    if buf.len() >= 3 && win_is_sep(buf[0]) && buf[1] == b'?' && buf[2] == b'?' {
        out.prepend(b"\\.");
    }
}

fn path_has_prefix_fold(s: &[u8], prefix: &[u8]) -> bool {
    if s.len() < prefix.len() {
        return false;
    }
    for (i, &pc) in prefix.iter().enumerate() {
        if win_is_sep(pc) {
            if !win_is_sep(s[i]) {
                return false;
            }
        } else if !pc.eq_ignore_ascii_case(&s[i]) {
            return false;
        }
    }
    s.len() <= prefix.len() || win_is_sep(s[prefix.len()])
}

fn unc_len(p: &[u8], prefix_len: usize) -> usize {
    let mut count = 0;
    for (i, &c) in p.iter().enumerate().skip(prefix_len) {
        if win_is_sep(c) {
            count += 1;
            if count == 2 {
                return i;
            }
        }
    }
    p.len()
}

fn cut_path(p: &[u8]) -> (&[u8], &[u8], bool) {
    match p.iter().position(|&c| win_is_sep(c)) {
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

fn win_volume_name_len(p: &[u8]) -> usize {
    if p.len() >= 2 && p[1] == b':' {
        return 2;
    }
    if p.is_empty() || !win_is_sep(p[0]) {
        return 0;
    }
    if path_has_prefix_fold(p, b"\\\\.")
        || path_has_prefix_fold(p, b"\\\\?")
        || path_has_prefix_fold(p, b"\\??")
    {
        if p.len() == 3 {
            return 3;
        }
        if path_has_prefix_fold(&p[4..], b"UNC") {
            return valid_volume_name_len(p, unc_len(p, b"\\\\.\\UNC\\".len()));
        }
        let (_, rest, ok) = cut_path(&p[4..]);
        if !ok {
            return valid_volume_name_len(p, p.len());
        }
        return valid_volume_name_len(p, p.len() - rest.len() - 1);
    }
    if p.len() >= 2 && win_is_sep(p[1]) {
        return valid_volume_name_len(p, unc_len(p, 2));
    }
    0
}

#[cfg(test)]
mod tests;
