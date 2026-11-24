//! Go `path` 패키지(슬래시 경로)의 규칙이다 (go1.27.2 `src/path/path.go`).
//!
//! 바이트 단위로 다룬다. 구분자 `/` 는 ASCII 이므로 UTF-8 경계를 가르지 않는다.

/// Go `path.Clean`.
pub fn clean(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let p = path.as_bytes();
    let rooted = p[0] == b'/';
    let n = p.len();
    let mut out: Vec<u8> = Vec::with_capacity(n);
    let (mut r, mut dotdot) = (0, 0);
    if rooted {
        out.push(b'/');
        r = 1;
        dotdot = 1;
    }
    while r < n {
        if p[r] == b'/' || (p[r] == b'.' && (r + 1 == n || p[r + 1] == b'/')) {
            r += 1;
        } else if p[r] == b'.' && p[r + 1] == b'.' && (r + 2 == n || p[r + 2] == b'/') {
            r += 2;
            if out.len() > dotdot {
                out.pop();
                while out.len() > dotdot && out[out.len() - 1] != b'/' {
                    out.pop();
                }
                if out.len() > dotdot {
                    out.pop();
                }
            } else if !rooted {
                if !out.is_empty() {
                    out.push(b'/');
                }
                out.extend_from_slice(b"..");
                dotdot = out.len();
            }
        } else {
            if (rooted && out.len() != 1) || (!rooted && !out.is_empty()) {
                out.push(b'/');
            }
            while r < n && p[r] != b'/' {
                out.push(p[r]);
                r += 1;
            }
        }
    }
    if out.is_empty() {
        return ".".to_owned();
    }
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// Go `path.Split`: 마지막 `/` 바로 뒤에서 가른다.
pub fn split(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(i) => path.split_at(i + 1),
        None => ("", path),
    }
}

/// Go `path.Join`: 빈 조각을 건너뛰고 `/` 로 이은 뒤 [`clean`] 한다. 모두 비면 빈 문자열이다.
pub fn join<S: AsRef<str>>(elem: &[S]) -> String {
    if elem.iter().all(|e| e.as_ref().is_empty()) {
        return String::new();
    }
    let mut buf = String::new();
    for e in elem {
        let e = e.as_ref();
        if !buf.is_empty() || !e.is_empty() {
            if !buf.is_empty() {
                buf.push('/');
            }
            buf.push_str(e);
        }
    }
    clean(&buf)
}

/// Go `path.Ext`.
pub fn ext(path: &str) -> &str {
    let b = path.as_bytes();
    for i in (0..b.len()).rev() {
        if b[i] == b'/' {
            break;
        }
        if b[i] == b'.' {
            return &path[i..];
        }
    }
    ""
}

/// Go `path.Base`.
pub fn base(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let p = path.trim_end_matches('/');
    let p = match p.rfind('/') {
        Some(i) => &p[i + 1..],
        None => p,
    };
    if p.is_empty() {
        return "/".to_owned();
    }
    p.to_owned()
}

/// Go `path.IsAbs`.
pub fn is_abs(path: &str) -> bool {
    path.starts_with('/')
}

/// Go `path.Dir`.
pub fn dir(path: &str) -> String {
    clean(split(path).0)
}
