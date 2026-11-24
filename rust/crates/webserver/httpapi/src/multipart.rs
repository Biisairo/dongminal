//! 업로드 본문의 multipart 폼 (Go `http.Request.FormFile`·`FormValue` 가 하던 일, go1.27.2
//! `mime/multipart`). 본문 전체를 먼저 읽는다 — Go 처럼 폼을 다 읽은 뒤에야 파일을 놓는다.
//!
//! 갈래는 셋만 관측된다: 성공, 본문 상한 초과(413), 그 밖의 실패(400). 그래서 Go 의 판정 순서와
//! 상한(부분 1000개, 헤더 10000개, 메모리 32MiB+10MiB)을 따르되 오류 문구는 두지 않는다.

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use bytes::Bytes;
use http_body_util::BodyExt;
use otter_gocompat::filepath;

use crate::mediatype::parse_media_type;
use crate::req::Req;

/// Go `defaultMaxMemory`.
const DEFAULT_MAX_MEMORY: i64 = 32 << 20;
/// Go `readForm` 의 값 여유(`maxMemory + 10<<20`).
const VALUE_MEMORY_EXTRA: i64 = 10 << 20;
/// Go `multipartmaxparts` 기본값.
const MAX_PARTS: usize = 1000;
/// Go `maxMIMEHeaders` 기본값.
const MAX_HEADERS: i64 = 10000;
/// Go `peekBufferSize` — 부분 사이의 한 줄이 이보다 길면 실패한다.
const PEEK_BUFFER_SIZE: usize = 4096;
/// Go `readForm` 의 항목당 덧셈.
const MAP_ENTRY_OVERHEAD: i64 = 200;
const FILE_HEADER_SIZE: i64 = 100;

/// 폼을 읽지 못했다.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum FormError {
    /// 본문이 상한을 넘었다 (Go `*http.MaxBytesError`).
    TooLarge,
    /// 그 밖의 실패 — multipart 가 아니다, 형식이 틀렸다, `file` 이 없다.
    Bad,
}

/// 받은 파일 하나다. 메모리 상한을 넘으면 임시 파일에 있다.
pub(crate) struct FormFile {
    pub(crate) filename: String,
    pub(crate) data: Spool,
}

pub(crate) enum Spool {
    Mem(Vec<u8>),
    Disk(TempPath),
}

/// 놓으면 지워지는 임시 파일이다 (Go `MultipartForm.RemoveAll`).
pub(crate) struct TempPath(pub(crate) PathBuf);

impl Drop for TempPath {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub(crate) struct Form {
    query: otter_gocompat::neturl::Values,
    values: Vec<(String, String)>,
    pub(crate) file: FormFile,
}

impl Form {
    /// Go `FormValue`: 쿼리의 값이 본문의 값보다 앞선다 (`r.Form` 의 순서).
    pub(crate) fn value(&self, key: &str) -> String {
        if let Some(v) = self.query.get(key) {
            return v;
        }
        self.values
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    }
}

static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn create_temp() -> std::io::Result<(std::fs::File, TempPath)> {
    let dir = std::env::temp_dir();
    loop {
        let n = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        let p = dir.join(format!("multipart-{}{nanos}{n}", std::process::id()));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        // Go `os.CreateTemp` 처럼 0600 이다 — 공용 임시 디렉터리에 남의 업로드가 보이지 않는다.
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        match opts.open(&p) {
            Ok(f) => return Ok((f, TempPath(p))),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
}

/// 받는 중인 파일이다.
struct Spooler {
    mem: Vec<u8>,
    disk: Option<(std::fs::File, TempPath)>,
    max_mem: i64,
}

impl Spooler {
    fn write(&mut self, b: &[u8]) -> Result<(), FormError> {
        if self.disk.is_none() && len64(self.mem.len() + b.len()) > self.max_mem {
            let (mut f, p) = create_temp().map_err(|_| FormError::Bad)?;
            f.write_all(&self.mem).map_err(|_| FormError::Bad)?;
            self.mem = Vec::new();
            self.disk = Some((f, p));
        }
        match &mut self.disk {
            Some((f, _)) => f.write_all(b).map_err(|_| FormError::Bad),
            None => {
                self.mem.extend_from_slice(b);
                Ok(())
            }
        }
    }

    fn finish(self) -> Spool {
        match self.disk {
            Some((_, p)) => Spool::Disk(p),
            None => Spool::Mem(self.mem),
        }
    }
}

fn len64(n: usize) -> i64 {
    i64::try_from(n).unwrap_or(i64::MAX)
}

enum Sink {
    Discard,
    Value(String, Vec<u8>),
    /// 이름이 `file` 인 첫 파일이다.
    Wanted(String, Spooler),
    /// 그 밖의 파일 — 크기만 센다.
    Other,
}

enum State {
    Between { expect_new: bool },
    Headers,
    Body { total: usize, sink: Sink },
    Done,
}

/// 본문 바이트를 받아 Go `multipart.Reader.ReadForm` 처럼 나눈다.
struct Parser {
    nl: Vec<u8>,
    nl_dash_boundary: Vec<u8>,
    dash_boundary: Vec<u8>,
    dash_boundary_dash: Vec<u8>,
    parts_read: usize,
    state: State,
    buf: Vec<u8>,
    max_parts: usize,
    max_headers: i64,
    max_memory: i64,
    max_file_memory: i64,
    values: Vec<(String, String)>,
    file: Option<FormFile>,
}

fn skip_lwsp(b: &[u8]) -> &[u8] {
    let i = b
        .iter()
        .position(|&c| c != b' ' && c != b'\t')
        .unwrap_or(b.len());
    &b[i..]
}

/// Go `matchAfterPrefix`: +1 이면 경계, -1 이면 아님, 0 이면 더 읽어야 한다.
fn match_after_prefix(buf: &[u8], prefix: &[u8], eof: bool) -> i8 {
    if buf.len() == prefix.len() {
        return if eof { 1 } else { 0 };
    }
    let c = buf[prefix.len()];
    if matches!(c, b' ' | b'\t' | b'\r' | b'\n') {
        return 1;
    }
    if c == b'-' {
        if buf.len() == prefix.len() + 1 {
            return if eof { -1 } else { 0 };
        }
        if buf[prefix.len() + 1] == b'-' {
            return 1;
        }
    }
    -1
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// 한 번의 진행 결과다.
enum Step {
    /// 더 읽어야 한다.
    More,
    Done,
}

impl Parser {
    fn new(boundary: &[u8]) -> Parser {
        let mut b = b"\r\n--".to_vec();
        b.extend_from_slice(boundary);
        let dash_boundary = b[2..].to_vec();
        let mut dash_boundary_dash = dash_boundary.clone();
        dash_boundary_dash.extend_from_slice(b"--");
        Parser {
            nl: b"\r\n".to_vec(),
            nl_dash_boundary: b,
            dash_boundary,
            dash_boundary_dash,
            parts_read: 0,
            state: State::Between { expect_new: false },
            buf: Vec::new(),
            max_parts: MAX_PARTS,
            max_headers: MAX_HEADERS,
            max_memory: DEFAULT_MAX_MEMORY + VALUE_MEMORY_EXTRA,
            max_file_memory: DEFAULT_MAX_MEMORY,
            values: Vec::new(),
            file: None,
        }
    }

    fn is_final_boundary(&self, line: &[u8]) -> bool {
        let Some(rest) = line.strip_prefix(self.dash_boundary_dash.as_slice()) else {
            return false;
        };
        let rest = skip_lwsp(rest);
        rest.is_empty() || rest == self.nl.as_slice()
    }

    fn is_boundary_delimiter_line(&mut self, line: &[u8]) -> bool {
        let Some(rest) = line.strip_prefix(self.dash_boundary.as_slice()) else {
            return false;
        };
        let rest = skip_lwsp(rest);
        if self.parts_read == 0 && rest == b"\n" {
            self.nl = b"\n".to_vec();
            self.nl_dash_boundary.remove(0);
        }
        rest == self.nl.as_slice()
    }

    /// 쌓인 바이트로 갈 수 있는 데까지 간다.
    fn advance(&mut self, eof: bool) -> Result<Step, FormError> {
        loop {
            match std::mem::replace(&mut self.state, State::Done) {
                State::Done => return Ok(Step::Done),
                State::Between { expect_new } => match self.between(expect_new, eof)? {
                    Some(next) => self.state = next,
                    None => {
                        self.state = State::Between { expect_new };
                        return Ok(Step::More);
                    }
                },
                State::Headers => match self.headers(eof)? {
                    Some(next) => self.state = next,
                    None => {
                        self.state = State::Headers;
                        return Ok(Step::More);
                    }
                },
                State::Body { total, sink } => match self.body(total, sink, eof)? {
                    Ok(next) => self.state = next,
                    Err(waiting) => {
                        self.state = waiting;
                        return Ok(Step::More);
                    }
                },
            }
        }
    }

    /// Go `nextPart` 의 줄 읽기. `None` 이면 더 읽어야 한다.
    fn between(&mut self, mut expect_new: bool, eof: bool) -> Result<Option<State>, FormError> {
        if self.dash_boundary == b"--" {
            return Err(FormError::Bad);
        }
        loop {
            let Some(i) = self.buf.iter().position(|&c| c == b'\n') else {
                if !eof {
                    if self.buf.len() >= PEEK_BUFFER_SIZE {
                        return Err(FormError::Bad);
                    }
                    return Ok(None);
                }
                let line = std::mem::take(&mut self.buf);
                if self.is_final_boundary(&line) {
                    return Ok(Some(State::Done));
                }
                return Err(FormError::Bad);
            };
            if i >= PEEK_BUFFER_SIZE {
                return Err(FormError::Bad);
            }
            let line: Vec<u8> = self.buf.drain(..=i).collect();
            if self.is_boundary_delimiter_line(&line) {
                self.parts_read += 1;
                return Ok(Some(State::Headers));
            }
            if self.is_final_boundary(&line) {
                return Ok(Some(State::Done));
            }
            if expect_new {
                return Err(FormError::Bad);
            }
            if self.parts_read == 0 {
                continue;
            }
            if line == self.nl {
                expect_new = true;
                continue;
            }
            return Err(FormError::Bad);
        }
    }

    /// Go `textproto.ReadMIMEHeader` 와 `readForm` 의 부분 판정. `None` 이면 더 읽어야 한다.
    fn headers(&mut self, eof: bool) -> Result<Option<State>, FormError> {
        let mut lines: Vec<&[u8]> = Vec::new();
        let mut pos = 0;
        let end = loop {
            let Some(i) = self.buf[pos..].iter().position(|&c| c == b'\n') else {
                if eof {
                    return Err(FormError::Bad);
                }
                if len64(self.buf.len()) > self.max_memory {
                    return Err(FormError::Bad);
                }
                return Ok(None);
            };
            let mut line = &self.buf[pos..pos + i];
            pos += i + 1;
            if let Some(l) = line.strip_suffix(b"\r") {
                line = l;
            }
            if line.is_empty() {
                break pos;
            }
            lines.push(line);
        };
        let mut header: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
        for line in lines {
            if line[0] == b' ' || line[0] == b'\t' {
                let Some(last) = header.last_mut() else {
                    return Err(FormError::Bad);
                };
                last.1.push(b' ');
                last.1.extend_from_slice(trim_ws(line));
                continue;
            }
            let Some(colon) = line.iter().position(|&c| c == b':') else {
                return Err(FormError::Bad);
            };
            let key = &line[..colon];
            if key.is_empty() || !key.iter().all(|&c| c > 0x20 && c < 0x7f) {
                return Err(FormError::Bad);
            }
            header.push((
                key.to_ascii_lowercase(),
                trim_ws(&line[colon + 1..]).to_vec(),
            ));
            if len64(header.len()) > self.max_headers {
                return Err(FormError::Bad);
            }
        }
        self.buf.drain(..end);
        self.start_part(&header).map(Some)
    }

    /// Go `readForm` 의 부분 하나의 시작.
    fn start_part(&mut self, header: &[(Vec<u8>, Vec<u8>)]) -> Result<State, FormError> {
        if self.max_parts == 0 {
            return Err(FormError::Bad);
        }
        self.max_parts -= 1;
        let disp = header
            .iter()
            .find(|(k, _)| k == b"content-disposition")
            .map(|(_, v)| v.as_slice())
            .unwrap_or_default();
        let (name, filename) = match parse_media_type(disp) {
            Ok((d, params)) if d == "form-data" => (
                params.get("name").cloned().unwrap_or_default(),
                params.get("filename").cloned().unwrap_or_default(),
            ),
            _ => (Vec::new(), Vec::new()),
        };
        if name.is_empty() {
            return Ok(State::Body {
                total: 0,
                sink: Sink::Discard,
            });
        }
        let name = String::from_utf8_lossy(&name).into_owned();
        self.max_memory -= len64(name.len()) + MAP_ENTRY_OVERHEAD;
        if self.max_memory < 0 {
            return Err(FormError::Bad);
        }
        if filename.is_empty() {
            return Ok(State::Body {
                total: 0,
                sink: Sink::Value(name, Vec::new()),
            });
        }
        let header_size = 400
            + header
                .iter()
                .map(|(k, v)| len64(k.len()) + MAP_ENTRY_OVERHEAD + len64(v.len()))
                .sum::<i64>();
        self.max_memory -= header_size + MAP_ENTRY_OVERHEAD + FILE_HEADER_SIZE;
        if self.max_memory < 0 {
            return Err(FormError::Bad);
        }
        self.max_headers -= len64(header.len());
        // Go `Part.FileName`: 마지막 조각만 쓴다.
        let filename = filepath::base(&String::from_utf8_lossy(&filename));
        let sink = if name == "file" && self.file.is_none() {
            Sink::Wanted(
                filename,
                Spooler {
                    mem: Vec::new(),
                    disk: None,
                    max_mem: self.max_file_memory,
                },
            )
        } else {
            Sink::Other
        };
        Ok(State::Body { total: 0, sink })
    }

    /// Go `scanUntilBoundary`. `(n, found)` — 앞 n 바이트가 부분의 내용이고, found 면 그 뒤가 경계다.
    fn scan(&self, total: usize, eof: bool) -> (usize, bool) {
        let buf = self.buf.as_slice();
        if total == 0 {
            if buf.starts_with(&self.dash_boundary) {
                match match_after_prefix(buf, &self.dash_boundary, eof) {
                    -1 => return (self.dash_boundary.len(), false),
                    0 => return (0, false),
                    _ => return (0, true),
                }
            }
            if self.dash_boundary.starts_with(buf) {
                return (0, false);
            }
        }
        if let Some(i) = find(buf, &self.nl_dash_boundary) {
            match match_after_prefix(&buf[i..], &self.nl_dash_boundary, eof) {
                -1 => return (i + self.nl_dash_boundary.len(), false),
                0 => return (i, false),
                _ => return (i, true),
            }
        }
        if self.nl_dash_boundary.starts_with(buf) {
            return (0, false);
        }
        if let Some(i) = buf.iter().rposition(|&c| c == self.nl_dash_boundary[0])
            && self.nl_dash_boundary.starts_with(&buf[i..])
        {
            return (i, false);
        }
        (buf.len(), false)
    }

    /// 부분의 내용을 읽는다. `Err(state)` 면 더 읽어야 한다.
    fn body(
        &mut self,
        mut total: usize,
        mut sink: Sink,
        eof: bool,
    ) -> Result<Result<State, State>, FormError> {
        loop {
            let (n, found) = self.scan(total, eof);
            if n > 0 {
                let chunk: Vec<u8> = self.buf.drain(..n).collect();
                total += n;
                match &mut sink {
                    Sink::Value(_, b) => {
                        b.extend_from_slice(&chunk);
                        if len64(b.len()) > self.max_memory {
                            return Err(FormError::Bad);
                        }
                    }
                    Sink::Wanted(_, s) => s.write(&chunk)?,
                    Sink::Discard | Sink::Other => {}
                }
            }
            if found {
                self.end_part(total, sink);
                return Ok(Ok(State::Between { expect_new: false }));
            }
            if n == 0 {
                if eof {
                    // Go `io.ErrUnexpectedEOF`.
                    return Err(FormError::Bad);
                }
                return Ok(Err(State::Body { total, sink }));
            }
        }
    }

    fn end_part(&mut self, total: usize, sink: Sink) {
        let n = len64(total);
        match sink {
            Sink::Discard => {}
            Sink::Value(name, b) => {
                self.max_memory -= n;
                self.values
                    .push((name, String::from_utf8_lossy(&b).into_owned()));
            }
            Sink::Wanted(filename, s) => {
                self.charge_file(n);
                self.file = Some(FormFile {
                    filename,
                    data: s.finish(),
                });
            }
            Sink::Other => self.charge_file(n),
        }
    }

    /// 메모리에 남는 파일만 상한을 깎는다 (Go `readForm`).
    fn charge_file(&mut self, n: i64) {
        if n <= self.max_file_memory {
            self.max_file_memory -= n;
            self.max_memory -= n;
        }
    }
}

fn trim_ws(b: &[u8]) -> &[u8] {
    let s = b
        .iter()
        .position(|&c| c != b' ' && c != b'\t')
        .unwrap_or(b.len());
    let e = b
        .iter()
        .rposition(|&c| c != b' ' && c != b'\t')
        .map_or(s, |i| i + 1);
    &b[s..e.max(s)]
}

/// Go `r.Body = http.MaxBytesReader(w, r.Body, limit)` 뒤의 `r.FormFile("file")`. 파일을 메모리나
/// 임시 파일에 다 받은 뒤 돌려준다.
pub(crate) async fn read_form(r: &Req, limit: i64) -> Result<Form, FormError> {
    let (query, query_err) = otter_gocompat::neturl::parse_query(&r.raw_query);
    let ct = r
        .headers
        .get(http::header::CONTENT_TYPE)
        .map(|v| v.as_bytes())
        .unwrap_or_default();
    if ct.is_empty() {
        return Err(FormError::Bad);
    }
    let (mt, params) = parse_media_type(ct).map_err(|_| FormError::Bad)?;
    if mt != "multipart/form-data" {
        return Err(FormError::Bad);
    }
    let boundary = params.get("boundary").ok_or(FormError::Bad)?;
    let mut p = Parser::new(boundary);

    let limit = u64::try_from(limit).unwrap_or(0);
    let mut body = r.take_body();
    let mut read: u64 = 0;
    let mut eof = false;
    let mut over = false;
    loop {
        if let Step::Done = p.advance(eof)? {
            break;
        }
        if eof {
            return Err(FormError::Bad);
        }
        if over {
            return Err(FormError::TooLarge);
        }
        match body.frame().await {
            None => eof = true,
            Some(Err(_)) => return Err(FormError::Bad),
            Some(Ok(f)) => {
                let Ok(data) = f.into_data() else {
                    continue;
                };
                let data: Bytes = data;
                let room = limit.saturating_sub(read);
                let n = data.len().min(usize::try_from(room).unwrap_or(usize::MAX));
                read += n as u64;
                p.buf.extend_from_slice(&data[..n]);
                if n < data.len() {
                    over = true;
                }
            }
        }
    }
    let file = p.file.take().ok_or(FormError::Bad)?;
    // Go `ParseMultipartForm` 은 폼을 읽은 뒤에 쿼리 해석의 실패를 돌려준다.
    if query_err.is_some() {
        return Err(FormError::Bad);
    }
    Ok(Form {
        query,
        values: p.values,
        file,
    })
}
