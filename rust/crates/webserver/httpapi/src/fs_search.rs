//! `GET /api/fs/{find,grep}` — Editor 창의 파일 이름 찾기와 전체 내용 찾기 (Go
//! `handlers_fs_search.go`, EDITOR_GIT_UX_SRS 묶음 F·G).
//!
//! 루트 가드는 `fs_root` 를 그대로 딛는다 (FR-EQO-2 · FR-EGS-2, D-3).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use http::StatusCode;
use otter_gocompat::filepath;
use otter_shared_httpresp::{self as httpresp, Response};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::Server;
use crate::ansi::go_string;
use crate::file_probe::is_binary;
use crate::fs::{FS_ERR_BAD_REQUEST, FS_ERR_IO, FsError, fs_cause, fs_fail, fs_fail_err};
use crate::req::Req;

/// 이름 찾기와 내용 찾기의 기본 상한.
pub(crate) const FS_FIND_LIMIT: usize = 300;
pub(crate) const FS_GREP_LIMIT: usize = 500;
/// FR-EGS-5: 이보다 큰 파일은 훑지 않는다.
pub(crate) const FS_GREP_MAX_BYTES: u64 = 2 << 20;
/// 한 줄이 이보다 길면 잘라서 싣는다.
pub(crate) const FS_GREP_MAX_LINE: usize = 400;

/// 어느 구현으로 훑었는지 (FR-EGS-3).
pub(crate) const GREP_ENGINE_RIPGREP: &str = "ripgrep";
pub(crate) const GREP_ENGINE_GO: &str = "go";

/// rg --json 이벤트 한 줄의 상한이다. 그보다 긴 줄에서 읽기를 멈추고 그때까지의 매치를 준다.
const RG_JSON_LINE_MAX: usize = 4 << 20;

/// 이름 찾기와 내용 찾기가 **함께** 딛는 제외 목록이다 (D-5).
pub(crate) const FS_SKIP_DIRS: [&str; 13] = [
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "vendor",
    "dist",
    "build",
    "target",
    ".next",
    ".venv",
    "__pycache__",
    ".idea",
    ".DS_Store",
];

/// 순회가 취소로 멈췄다 (Go `ctx.Err()`).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Canceled;

fn canceled_fail() -> FsError {
    fs_cause(FS_ERR_IO, "context canceled")
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct FindHit {
    pub(crate) path: String,
    pub(crate) name: String,
}

#[derive(Serialize)]
struct FindResp {
    files: Vec<FindHit>,
    root: String,
    truncated: bool,
}

/// 두 구현이 함께 내는 결과 형태다 (FR-EGS-4).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub(crate) struct GrepMatch {
    pub(crate) path: String,
    pub(crate) line: i64,
    pub(crate) col: i64,
    pub(crate) text: String,
}

#[derive(Serialize)]
struct GrepResp {
    engine: &'static str,
    matches: Vec<GrepMatch>,
    root: String,
    truncated: bool,
}

/// 순회가 넘기는 일반 파일 하나.
pub(crate) struct WalkFile<'a> {
    pub(crate) path: &'a Path,
    /// root 기준의 슬래시 경로.
    pub(crate) rel: &'a str,
    pub(crate) name: &'a str,
}

fn name_string(n: &std::ffi::OsStr) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        go_string(n.as_bytes())
    }
    #[cfg(not(unix))]
    {
        n.to_string_lossy().into_owned()
    }
}

fn sorted_entries(dir: &Path) -> Option<Vec<std::fs::DirEntry>> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut v = Vec::new();
    for e in rd {
        v.push(e.ok()?);
    }
    v.sort_by_key(std::fs::DirEntry::file_name);
    Some(v)
}

/// Go `fsWalkFiles`: 두 검색 구현이 공유하는 순회다 (FR-DRC-11). 읽을 수 없는 가지는 건너뛰고,
/// 취소는 즉시 올리고, `FS_SKIP_DIRS` 는 통째로 자르고, 심링크는 따라가지 않는다. 순서는 Go
/// `filepath.WalkDir` 처럼 이름의 바이트 순이다. visit 이 false 면 끝낸다.
pub(crate) fn fs_walk_files(
    ctx: &CancellationToken,
    root: &str,
    visit: &mut dyn FnMut(WalkFile<'_>) -> bool,
) -> Result<(), Canceled> {
    let root_path = PathBuf::from(root);
    let Ok(st) = std::fs::symlink_metadata(&root_path) else {
        return Ok(());
    };
    if ctx.is_cancelled() {
        return Err(Canceled);
    }
    let ft = st.file_type();
    if ft.is_symlink() {
        return Ok(());
    }
    if !ft.is_dir() {
        let name = name_string(root_path.file_name().unwrap_or_default());
        visit(WalkFile {
            path: &root_path,
            rel: ".",
            name: &name,
        });
        return Ok(());
    }
    walk_dir(ctx, &root_path, "", visit).map(|_| ())
}

/// 한 디렉터리 아래를 걷는다. `Ok(false)` 는 visit 이 멈추라고 한 것이다.
fn walk_dir(
    ctx: &CancellationToken,
    dir: &Path,
    rel: &str,
    visit: &mut dyn FnMut(WalkFile<'_>) -> bool,
) -> Result<bool, Canceled> {
    let Some(entries) = sorted_entries(dir) else {
        return Ok(true);
    };
    for e in entries {
        if ctx.is_cancelled() {
            return Err(Canceled);
        }
        let Ok(ft) = e.file_type() else {
            continue;
        };
        let name = name_string(&e.file_name());
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let path = e.path();
        if ft.is_dir() {
            if FS_SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if !walk_dir(ctx, &path, &child_rel, visit)? {
                return Ok(false);
            }
            continue;
        }
        if ft.is_symlink() {
            continue;
        }
        if !visit(WalkFile {
            path: &path,
            rel: &child_rel,
            name: &name,
        }) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Go `strings.ToLower`: 잘못된 바이트는 U+FFFD 가 되고, 글자마다 첫 소문자 하나를 쓴다.
fn go_lower(s: &str) -> String {
    if s.is_ascii() {
        return s.to_ascii_lowercase();
    }
    s.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

/// Go `findFiles`: 상대경로가 q 를 품는 파일을 모은다 (FR-EQO-1·3·6).
pub(crate) fn find_files(
    ctx: &CancellationToken,
    root: &str,
    q: &str,
    limit: usize,
) -> Result<(Vec<FindHit>, bool), Canceled> {
    let needle = go_lower(&filepath::to_slash(q));
    let mut out = Vec::new();
    let mut truncated = false;
    fs_walk_files(ctx, root, &mut |f| {
        if !go_lower(f.rel).contains(&needle) {
            return true;
        }
        if out.len() >= limit {
            truncated = true;
            return false;
        }
        out.push(FindHit {
            path: f.rel.to_owned(),
            name: f.name.to_owned(),
        });
        true
    })?;
    Ok((out, truncated))
}

/// Go `grepIndexFold`: `strings.Index(strings.ToLower(line), needle)` 와 같은 답이다.
fn grep_index_fold(line: &[u8], needle: &str) -> Option<usize> {
    if line.is_ascii() {
        let low = line.to_ascii_lowercase();
        return find_bytes(&low, needle.as_bytes());
    }
    go_lower(&go_string(line)).find(needle)
}

fn find_bytes(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

/// Go `clipLine`: 룬의 시작으로 물려 자른다.
fn clip_line(s: &[u8]) -> &[u8] {
    if s.len() <= FS_GREP_MAX_LINE {
        return s;
    }
    let mut cut = FS_GREP_MAX_LINE;
    while cut > 0 && (s[cut] & 0xC0) == 0x80 {
        cut -= 1;
    }
    &s[..cut]
}

/// Go `grepWithGo`: ripgrep 이 없을 때의 폴백이다 (FR-EGS-3). `\n` 이 구분자이고 마지막 개행 뒤의
/// (빈) 조각도 한 줄이다. `col` 은 `\r` 을 떼기 **전** 줄에서의 자리다 (FR-PRF-59).
pub(crate) fn grep_with_go(
    ctx: &CancellationToken,
    root: &str,
    q: &str,
    limit: usize,
) -> Result<(Vec<GrepMatch>, bool), Canceled> {
    let needle = go_lower(q);
    let mut matches = Vec::new();
    let mut truncated = false;
    fs_walk_files(ctx, root, &mut |f| {
        let Ok(info) = std::fs::symlink_metadata(f.path) else {
            return true;
        };
        if info.len() > FS_GREP_MAX_BYTES {
            return true;
        }
        let Ok(mut file) = std::fs::File::open(f.path) else {
            return true;
        };
        // 읽다 실패하면 그때까지 읽은 것이 그 파일의 전부다.
        let mut blob = Vec::new();
        let _ = file.read_to_end(&mut blob);
        let head = &blob[..blob.len().min(otter_shared_editorlimit::BINARY_SNIFF_BYTES)];
        if is_binary(head) {
            return true;
        }
        for (i, line) in blob.split(|&b| b == b'\n').enumerate() {
            let Some(idx) = grep_index_fold(line, &needle) else {
                continue;
            };
            if matches.len() >= limit {
                truncated = true;
                return false;
            }
            let mut end = line.len();
            while end > 0 && line[end - 1] == b'\r' {
                end -= 1;
            }
            matches.push(GrepMatch {
                path: f.rel.to_owned(),
                line: i as i64 + 1,
                col: idx as i64 + 1,
                text: go_string(clip_line(&line[..end])),
            });
        }
        true
    })?;
    Ok((matches, truncated))
}

/// Go `exec.LookPath("rg")`. 상대 경로에서 찾은 것은 쓰지 않는다(Go `ErrDot`).
pub(crate) fn look_ripgrep() -> Option<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in filepath::split_list(&path) {
        let dir = if dir.is_empty() { ".".to_owned() } else { dir };
        if let Some(p) = find_executable(&dir, "rg") {
            return filepath::is_abs(&p).then_some(p);
        }
    }
    None
}

#[cfg(unix)]
fn find_executable(dir: &str, name: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let p = filepath::join(&[dir, name]);
    let st = std::fs::metadata(&p).ok()?;
    (!st.is_dir() && st.permissions().mode() & 0o111 != 0).then_some(p)
}

#[cfg(not(unix))]
fn find_executable(dir: &str, name: &str) -> Option<String> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".com;.exe;.bat;.cmd".to_owned());
    for ext in exts.split(';').filter(|e| !e.is_empty()) {
        let p = filepath::join(&[dir, &format!("{name}{}", ext.to_lowercase())]);
        if std::fs::metadata(&p).is_ok_and(|st| !st.is_dir()) {
            return Some(p);
        }
    }
    None
}

/// ripgrep 을 쓰지 못했다. Go 구현으로 물러선다.
#[derive(Debug)]
pub(crate) struct RgFailed;

/// Go `grepWithRipgrep`: 질의는 **인자로만** 넘어간다 (FR-EGS-9, D-4). `--fixed-strings` 로
/// 정규식 해석도 끈다.
pub(crate) async fn grep_with_ripgrep(
    ctx: &CancellationToken,
    rg: &str,
    root: &str,
    q: &str,
    limit: usize,
) -> Result<(Vec<GrepMatch>, bool), RgFailed> {
    let mut args: Vec<String> = vec![
        "--json".into(),
        "--fixed-strings".into(),
        "--ignore-case".into(),
        "--max-filesize".into(),
        FS_GREP_MAX_BYTES.to_string(),
        // FR-EGS-7: 제외 목록은 find 와 같은 한 벌에서 온다.
        "--no-follow".into(),
    ];
    for name in FS_SKIP_DIRS {
        args.push("--glob".into());
        args.push(format!("!{name}/"));
    }
    args.extend(["--".into(), q.to_owned(), root.to_owned()]);
    let child = tokio::process::Command::new(rg)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| RgFailed)?;
    let out = tokio::select! {
        o = child.wait_with_output() => o.map_err(|_| RgFailed)?,
        _ = ctx.cancelled() => return Err(RgFailed),
    };
    // rg 는 "찾은 것 없음"에 1 을 낸다. 그것은 오류가 아니다.
    if !out.status.success() && out.stdout.is_empty() && out.status.code() != Some(1) {
        return Err(RgFailed);
    }
    Ok(parse_ripgrep_json(&out.stdout, root, limit))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RgText {
    text: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RgSub {
    start: i64,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RgData {
    path: RgText,
    lines: RgText,
    line_number: Option<i64>,
    submatches: Option<Vec<RgSub>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RgEvent {
    #[serde(rename = "type")]
    kind: String,
    data: RgData,
}

/// Go `parseRipgrepJSON`: rg --json 의 줄 단위 이벤트에서 match 만 골라 담는다. 줄 나누기는
/// `bufio.Scanner`(줄 끝 `\r` 제거, 상한 `RG_JSON_LINE_MAX`)와 같다.
pub(crate) fn parse_ripgrep_json(out: &[u8], root: &str, limit: usize) -> (Vec<GrepMatch>, bool) {
    let mut matches = Vec::new();
    let mut rest = out;
    while !rest.is_empty() {
        let (mut line, next) = match rest.iter().position(|&b| b == b'\n') {
            Some(i) => (&rest[..i], &rest[i + 1..]),
            None => (rest, &rest[rest.len()..]),
        };
        if line.len() >= RG_JSON_LINE_MAX {
            break;
        }
        rest = next;
        if let Some(l) = line.strip_suffix(b"\r") {
            line = l;
        }
        let Ok(ev) = otter_gocompat::json::unmarshal::<RgEvent>(line) else {
            continue;
        };
        if ev.kind != "match" {
            continue;
        }
        if matches.len() >= limit {
            return (matches, true);
        }
        let Ok(rel) = filepath::rel(root, &ev.data.path.text) else {
            continue;
        };
        let col = ev
            .data
            .submatches
            .as_deref()
            .and_then(<[RgSub]>::first)
            .map_or(1, |s| s.start + 1);
        let text = ev.data.lines.text.trim_end_matches(['\r', '\n']);
        matches.push(GrepMatch {
            path: filepath::to_slash(&rel),
            line: ev.data.line_number.unwrap_or(0),
            col,
            text: go_string(clip_line(text.as_bytes())),
        });
    }
    (matches, false)
}

/// Go `strconv.Atoi` 가 받는 꼴의 정수다.
fn atoi(v: &str) -> Option<i64> {
    let digits = v.strip_prefix(['+', '-']).unwrap_or(v);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    v.parse::<i64>().ok()
}

async fn off_thread<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(f).await {
        Ok(v) => v,
        Err(e) => std::panic::resume_unwind(e.into_panic()),
    }
}

impl Server {
    /// Go `fsSearchQuery`: 빈 질의를 거부하는 것이 핵심이다.
    fn fs_search_query(
        &self,
        r: &Req,
        def_limit: usize,
    ) -> Result<(String, String, usize), Response> {
        let root = self.fs_root(&r.q("root"))?;
        let q = r.q("q");
        if q.is_empty() {
            return Err(fs_fail(FS_ERR_BAD_REQUEST, "q 가 없다"));
        }
        let limit = atoi(&r.q("limit"))
            .filter(|n| *n > 0 && (*n as u64) < def_limit as u64)
            .map_or(def_limit, |n| n as usize);
        Ok((root, q, limit))
    }

    /// GET /api/fs/find — 이름이 q 에 맞는 파일의 상대경로 (FR-EQO-1).
    pub(crate) async fn api_fs_find(&self, r: &mut Req) -> Response {
        let (root, q, limit) = match self.fs_search_query(r, FS_FIND_LIMIT) {
            Ok(v) => v,
            Err(res) => return res,
        };
        let ctx = r.ctx.clone();
        let rt = root.clone();
        match off_thread(move || find_files(&ctx, &rt, &q, limit)).await {
            Ok((files, truncated)) => httpresp::json(
                StatusCode::OK,
                &FindResp {
                    files,
                    root,
                    truncated,
                },
            ),
            Err(Canceled) => fs_fail_err(&canceled_fail()),
        }
    }

    /// GET /api/fs/grep — 내용이 q 에 맞는 줄 (FR-EGS-1).
    pub(crate) async fn api_fs_grep(&self, r: &mut Req) -> Response {
        let (root, q, limit) = match self.fs_search_query(r, FS_GREP_LIMIT) {
            Ok(v) => v,
            Err(res) => return res,
        };
        // FR-EGS-3: ripgrep 이 있으면 그것을 쓴다. 실패하면 Go 구현으로 물러선다.
        if let Some(rg) = look_ripgrep()
            && let Ok((matches, truncated)) = grep_with_ripgrep(&r.ctx, &rg, &root, &q, limit).await
        {
            return httpresp::json(
                StatusCode::OK,
                &GrepResp {
                    engine: GREP_ENGINE_RIPGREP,
                    matches,
                    root,
                    truncated,
                },
            );
        }
        let ctx = r.ctx.clone();
        let rt = root.clone();
        match off_thread(move || grep_with_go(&ctx, &rt, &q, limit)).await {
            Ok((matches, truncated)) => httpresp::json(
                StatusCode::OK,
                &GrepResp {
                    engine: GREP_ENGINE_GO,
                    matches,
                    root,
                    truncated,
                },
            ),
            Err(Canceled) => fs_fail_err(&canceled_fail()),
        }
    }
}
