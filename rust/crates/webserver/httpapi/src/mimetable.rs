//! Go `mime.TypeByExtension` (go1.27.2 `mime/type.go`·`mime/type_unix.go`).
//!
//! 내장 표 위에 unix 호스트의 globs2 나 mime.types 를 얹는다. 처음 찾을 때 한 번만 읽는다.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;

use crate::mediatype::{format_media_type, parse_media_type};

/// Go `mimeGlobs`. FreeDesktop Shared MIME-info 데이터베이스다.
#[cfg(unix)]
const MIME_GLOBS: &[&str] = &["/usr/local/share/mime/globs2", "/usr/share/mime/globs2"];

/// Go `typeFiles`.
#[cfg(unix)]
const TYPE_FILES: &[&str] = &[
    "/etc/mime.types",
    "/etc/apache2/mime.types",
    "/etc/apache/mime.types",
    "/etc/httpd/conf/mime.types",
];

// DIFF: Go 는 Windows 에서 레지스트리(HKCR)의 Content Type 을 내장 표 위에 얹는다(`type_windows.go`).
// 여기서는 레지스트리를 읽지 않는다 — 호스트 파일이 없으니 내장 표만이다.
#[cfg(not(unix))]
const MIME_GLOBS: &[&str] = &[];
#[cfg(not(unix))]
const TYPE_FILES: &[&str] = &[];

/// Go `bufio.MaxScanTokenSize`. 이만큼 긴 줄을 만나면 Go 는 패닉한다.
const MAX_SCAN_TOKEN_SIZE: usize = 64 * 1024;

/// Go `mime` 의 내장 표(`builtinTypesLower`).
const BUILTIN_TYPES: &[(&str, &str)] = &[
    (".ai", "application/postscript"),
    (".apk", "application/vnd.android.package-archive"),
    (".apng", "image/apng"),
    (".avif", "image/avif"),
    (".bin", "application/octet-stream"),
    (".bmp", "image/bmp"),
    (".com", "application/octet-stream"),
    (".css", "text/css; charset=utf-8"),
    (".csv", "text/csv; charset=utf-8"),
    (".doc", "application/msword"),
    (
        ".docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    (".ehtml", "text/html; charset=utf-8"),
    (".eml", "message/rfc822"),
    (".eps", "application/postscript"),
    (".exe", "application/octet-stream"),
    (".flac", "audio/flac"),
    (".gif", "image/gif"),
    (".gz", "application/gzip"),
    (".htm", "text/html; charset=utf-8"),
    (".html", "text/html; charset=utf-8"),
    (".ico", "image/vnd.microsoft.icon"),
    (".ics", "text/calendar; charset=utf-8"),
    (".jfif", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".jpg", "image/jpeg"),
    (".js", "text/javascript; charset=utf-8"),
    (".json", "application/json"),
    (".m4a", "audio/mp4"),
    (".mjs", "text/javascript; charset=utf-8"),
    (".mp3", "audio/mpeg"),
    (".mp4", "video/mp4"),
    (".oga", "audio/ogg"),
    (".ogg", "audio/ogg"),
    (".ogv", "video/ogg"),
    (".opus", "audio/ogg"),
    (".pdf", "application/pdf"),
    (".pjp", "image/jpeg"),
    (".pjpeg", "image/jpeg"),
    (".png", "image/png"),
    (".ppt", "application/vnd.ms-powerpoint"),
    (
        ".pptx",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ),
    (".ps", "application/postscript"),
    (".rdf", "application/rdf+xml"),
    (".rtf", "application/rtf"),
    (".shtml", "text/html; charset=utf-8"),
    (".svg", "image/svg+xml"),
    (".text", "text/plain; charset=utf-8"),
    (".tif", "image/tiff"),
    (".tiff", "image/tiff"),
    (".txt", "text/plain; charset=utf-8"),
    (".vtt", "text/vtt; charset=utf-8"),
    (".wasm", "application/wasm"),
    (".wav", "audio/wav"),
    (".weba", "audio/webm"),
    (".webm", "video/webm"),
    (".webp", "image/webp"),
    (".xbl", "text/xml; charset=utf-8"),
    (".xbm", "image/x-xbitmap"),
    (".xht", "application/xhtml+xml"),
    (".xhtml", "application/xhtml+xml"),
    (".xls", "application/vnd.ms-excel"),
    (
        ".xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    (".xml", "text/xml; charset=utf-8"),
    (".xsl", "text/xml; charset=utf-8"),
    (".zip", "application/zip"),
];

/// Go `mimeTypes`(대소문자 그대로)·`mimeTypesLower`(소문자) 쌍이다.
#[derive(Debug)]
pub(crate) struct MimeTable {
    exact: HashMap<String, String>,
    lower: HashMap<String, String>,
}

impl MimeTable {
    /// Go `setMimeTypes(builtinTypesLower, builtinTypesLower)`.
    pub(crate) fn builtin() -> MimeTable {
        let m: HashMap<String, String> = BUILTIN_TYPES
            .iter()
            .map(|(e, t)| ((*e).to_owned(), (*t).to_owned()))
            .collect();
        MimeTable {
            exact: m.clone(),
            lower: m,
        }
    }

    /// Go `TypeByExtension`: 대소문자 그대로 먼저, 그다음 소문자로 찾는다. 모르면 빈 값이다.
    pub(crate) fn lookup(&self, ext: &str) -> &str {
        if let Some(v) = self.exact.get(ext) {
            return v;
        }
        self.lower.get(&go_to_lower(ext)).map_or("", String::as_str)
    }

    /// Go `setExtensionType`. 풀리지 않는 형식은 버린다. `text/` 에 charset 이 없으면 utf-8 을 붙인다.
    fn set_extension_type(&mut self, extension: &str, mime_type: &str) {
        let Ok((just_type, mut param)) = parse_media_type(mime_type.as_bytes()) else {
            return;
        };
        let mut mime_type = mime_type.to_owned();
        if mime_type.starts_with("text/") && param.get("charset").is_none_or(|c| c.is_empty()) {
            param.insert("charset".to_owned(), b"utf-8".to_vec());
            mime_type =
                String::from_utf8_lossy(&format_media_type(&just_type, &param)).into_owned();
        }
        self.exact.insert(extension.to_owned(), mime_type.clone());
        self.lower.insert(go_to_lower(extension), mime_type);
    }

    /// Go `loadMimeGlobsFile`. 열면 `true` 다 — 그러면 다음 파일을 보지 않는다.
    pub(crate) fn load_globs_file(&mut self, path: &Path) -> bool {
        let Some(lines) = read_lines(path) else {
            return false;
        };
        for line in lines {
            // 줄 형식: weight:mimetype:glob[:morefields...]
            let fields: Vec<&str> = line.split(':').collect();
            if fields.len() < 3 || fields[0].is_empty() || fields[2].len() < 3 {
                continue;
            }
            let glob = fields[2].as_bytes();
            if fields[0].starts_with('#') || glob[0] != b'*' || glob[1] != b'.' {
                continue;
            }
            let extension = &fields[2][1..];
            if extension.contains(['?', '*', '[']) {
                continue;
            }
            // 파일이 무게 순이라 처음 본 것을 지킨다. 내장 표도 이미 본 것이다.
            if self.exact.contains_key(extension) {
                continue;
            }
            self.set_extension_type(extension, fields[1]);
        }
        true
    }

    /// Go `loadMimeFile`. 뒤에 읽은 줄이 앞의 것(내장 표 포함)을 덮어쓴다.
    pub(crate) fn load_mime_file(&mut self, path: &Path) {
        let Some(lines) = read_lines(path) else {
            return;
        };
        for line in lines {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() <= 1 || fields[0].starts_with('#') {
                continue;
            }
            for ext in &fields[1..] {
                if ext.starts_with('#') {
                    break;
                }
                self.set_extension_type(&format!(".{ext}"), fields[0]);
            }
        }
    }
}

/// Go `initMimeUnix`: globs2 를 하나라도 열면 거기서 멈춘다. 없으면 mime.types 를 모두 읽는다.
pub(crate) fn init_mime_unix(globs: &[&Path], type_files: &[&Path]) -> MimeTable {
    let mut t = MimeTable::builtin();
    for g in globs {
        if t.load_globs_file(g) {
            return t;
        }
    }
    for f in type_files {
        t.load_mime_file(f);
    }
    t
}

fn init_mime() -> MimeTable {
    let globs: Vec<&Path> = MIME_GLOBS.iter().map(Path::new).collect();
    let files: Vec<&Path> = TYPE_FILES.iter().map(Path::new).collect();
    init_mime_unix(&globs, &files)
}

/// Go `mime.TypeByExtension`. 모르면 빈 값이다.
pub(crate) fn type_by_extension(ext: &str) -> &'static str {
    static TABLE: OnceLock<MimeTable> = OnceLock::new();
    TABLE.get_or_init(init_mime).lookup(ext)
}

/// Go `strings.ToLower`: 글자마다 단순 소문자다(`İ` 는 `i` 하나가 된다).
fn go_to_lower(s: &str) -> String {
    if s.is_ascii() {
        return s.to_ascii_lowercase();
    }
    s.chars()
        .map(|c| {
            if c == '\u{130}' {
                'i'
            } else {
                c.to_lowercase().next().unwrap_or(c)
            }
        })
        .collect()
}

/// Go `bufio.Scanner` 의 줄 나누기다. 열지 못하면 `None` 이다.
// DIFF: Go 는 읽기 오류나 64KiB 이상인 줄에서 패닉한다. 여기서는 그 앞까지만 쓴다.
fn read_lines(path: &Path) -> Option<Vec<String>> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let mut out = Vec::new();
    let mut rest = buf.as_slice();
    while !rest.is_empty() {
        let (line, next) = match rest.iter().position(|&b| b == b'\n') {
            Some(i) => (&rest[..i], &rest[i + 1..]),
            None => (rest, &[][..]),
        };
        if line.len() >= MAX_SCAN_TOKEN_SIZE {
            break;
        }
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        out.push(String::from_utf8_lossy(line).into_owned());
        rest = next;
    }
    Some(out)
}
