//! 정적 자산 `/` (Go `static.go`). 내용 기반 ETag·CSP·사전압축 자산·`index.html` 의 판 치환.
//!
//! 자산은 프로세스가 사는 동안 바뀌지 않으므로 해시와 `.gz` 바이트를 한 번만 읽어 기억한다.
//! 없는 경로는 기억하지 않는다 — 키가 요청 URL 에서 온다 (PERFORMANCE_HARDENING_SRS FR-PRF-53).

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, LazyLock, RwLock};

use base64::Engine;
use bytes::Bytes;
use dm_gocompat::path;
use dm_shared_httpresp::{self as httpresp, Response};
use dm_webserver_apierr as apierr;
use http::{HeaderMap, StatusCode, header};
use sha2::{Digest, Sha256};

use crate::Server;
use crate::access_denied::CSP_REST;
use crate::asset_version::{ASSET_VER_PLACEHOLDER, INDEX_PAGE, compute_asset_version};
use crate::httperr::http_err;
use crate::req::Req;
use crate::serve_content::{
    dir_list, go_error, local_redirect, serve_content, serve_error, set, type_by_extension,
};

/// 자산 디렉터리의 항목 하나 (Go `fs.DirEntry` 의 이름·디렉터리 여부).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetEntry {
    pub name: String,
    pub is_dir: bool,
}

/// 정적 자산의 공급원 (Go `Config.StaticFS` 의 `fs.FS`). 이름은 Go `fs.ValidPath` 모양이다 — 앞 `/`
/// 가 없고, 뿌리는 `"."` 이다.
pub trait StaticAssets: Send + Sync + std::fmt::Debug {
    /// 파일의 바이트다. 없거나 디렉터리면 `None`.
    fn read(&self, name: &str) -> Option<Cow<'static, [u8]>>;
    /// 디렉터리 바로 아래 항목이다. 디렉터리가 아니면 `None`.
    fn read_dir(&self, name: &str) -> Option<Vec<AssetEntry>>;
    fn is_file(&self, name: &str) -> bool {
        self.read(name).is_some()
    }
}

/// 바이너리에 담긴 `web/` 자산 (Go `web.FS()`, crate `dm-web-assets`).
#[derive(Debug, Clone, Copy, Default)]
pub struct WebAssets;

impl StaticAssets for WebAssets {
    fn read(&self, name: &str) -> Option<Cow<'static, [u8]>> {
        dm_web_assets::get(name)
    }

    fn read_dir(&self, name: &str) -> Option<Vec<AssetEntry>> {
        let dir = if name == "." { "" } else { name };
        dm_web_assets::read_dir(dir).map(|v| {
            v.into_iter()
                .map(|e| AssetEntry {
                    name: e.name,
                    is_dir: e.is_dir,
                })
                .collect()
        })
    }

    fn is_file(&self, name: &str) -> bool {
        dm_web_assets::get(name).is_some()
    }
}

/// 사전압축 자산의 접미사다. 담기는 이름은 `<논리 경로>.gz` 다.
const GZ_SUFFIX: &str = ".gz";

/// 우리가 내보내는 자산의 형식이다 (FR-MVN-7). 호스트 설정에 맡기지 않는다.
const STATIC_TYPES: [(&str, &str); 9] = [
    (".js", "text/javascript; charset=utf-8"),
    (".mjs", "text/javascript; charset=utf-8"),
    (".css", "text/css; charset=utf-8"),
    (".html", "text/html; charset=utf-8"),
    (".json", "application/json"),
    (".svg", "image/svg+xml"),
    (".woff2", "font/woff2"),
    (".map", "application/json"),
    (".webmanifest", "application/manifest+json"),
];

const OCTET_STREAM: &str = "application/octet-stream";

/// 속성이 없는 인라인 `<script>` 블록이다 (FR-MVN-13b).
static INLINE_SCRIPT_RE: LazyLock<regex::bytes::Regex> =
    LazyLock::new(|| regex::bytes::Regex::new(r"(?s)<script>(.*?)</script>").expect("고정 정규식"));

/// Go `cspFor`: 서빙될 문서의 인라인 스크립트 해시만 `script-src` 에 싣는다 (FR-MVN-13a).
pub(crate) fn csp_for(index: &[u8]) -> String {
    let mut b = String::from("default-src 'self'; script-src 'self'");
    for c in INLINE_SCRIPT_RE.captures_iter(index) {
        let sum = Sha256::digest(c.get(1).map_or(&[][..], |m| m.as_bytes()));
        b.push_str(" 'sha256-");
        b.push_str(&base64::engine::general_purpose::STANDARD.encode(sum));
        b.push('\'');
    }
    b.push_str("; ");
    b.push_str(CSP_REST);
    b
}

/// Go `contentTypeFor`: 확장자로 정한다. 모르면 sniff 하지 않고 octet-stream 이다.
pub(crate) fn content_type_for(name: &str) -> String {
    let ext = path::ext(name).to_lowercase();
    if let Some((_, ct)) = STATIC_TYPES.iter().find(|(e, _)| *e == ext) {
        return (*ct).to_owned();
    }
    match type_by_extension(&ext) {
        "" => OCTET_STREAM.to_owned(),
        ct => ct.to_owned(),
    }
}

fn trim_space(s: &str) -> &str {
    s.trim()
}

/// Go `acceptsGzip`: 토큰으로 읽는다 — `gzip;q=0` 은 받지 않겠다는 뜻이다.
pub(crate) fn accepts_gzip(r: &Req) -> bool {
    let ae = r.header("Accept-Encoding");
    for part in ae.split(',') {
        let fields: Vec<&str> = trim_space(part).split(';').collect();
        match trim_space(fields[0]).to_lowercase().as_str() {
            "gzip" | "x-gzip" | "*" => {}
            _ => continue,
        }
        if q_zero(&fields[1..]) {
            continue;
        }
        return true;
    }
    false
}

fn q_zero(params: &[&str]) -> bool {
    params.iter().any(|p| {
        trim_space(p)
            .to_lowercase()
            .strip_prefix("q=")
            .and_then(|v| trim_space(v).parse::<f64>().ok())
            .is_some_and(|q| q <= 0.0)
    })
}

fn is_html_path(p: &str) -> bool {
    p == "/" || p.ends_with('/') || p.ends_with(".html")
}

/// Go `fs.ValidPath`.
pub(crate) fn valid_path(name: &str) -> bool {
    if name == "." {
        return true;
    }
    name.split('/')
        .all(|e| !e.is_empty() && e != "." && e != "..")
}

/// Go `etagOf`: 약한 검증자가 아니다 — 바이트가 같아야 같다.
fn etag_of(sum: &[u8]) -> String {
    let hx = hex::encode(sum);
    format!("\"{}\"", &hx[..32])
}

fn hash_bytes(b: &[u8]) -> String {
    etag_of(&Sha256::digest(b))
}

fn replace_all(b: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i..].starts_with(from) {
            out.extend_from_slice(to);
            i += from.len();
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

fn to_bytes(c: Cow<'static, [u8]>) -> Bytes {
    match c {
        Cow::Borrowed(b) => Bytes::from_static(b),
        Cow::Owned(v) => Bytes::from(v),
    }
}

/// `path.Clean(url)` 에서 앞 `/` 하나를 뗀 자산 이름.
fn asset_name(url_path: &str) -> String {
    let c = path::clean(url_path);
    c.strip_prefix('/').map(str::to_owned).unwrap_or(c)
}

/// Go `staticHandler`.
pub(crate) struct StaticHandler {
    fsys: Arc<dyn StaticAssets>,
    /// 서빙하는 자산의 판이다 (FR-AVS-3).
    pub(crate) version: String,
    csp: String,
    /// 판을 치환한 `index.html` 이다. 읽지 못했으면 `None` 이고 그때는 파일 서버가 답한다.
    index: Option<Bytes>,
    index_etag: String,
    etags: RwLock<HashMap<String, String>>,
    /// 사전압축 자산의 담긴 바이트다 (FR-PRF-50). 해제본은 담지 않는다 (D-PRF-7).
    blobs: RwLock<HashMap<String, Bytes>>,
}

impl StaticHandler {
    /// Go `newStaticHandler` 와 `assetVersion` 을 한 자리에서 한다.
    pub(crate) fn new(fsys: Arc<dyn StaticAssets>) -> StaticHandler {
        let version = compute_asset_version(fsys.as_ref());
        let index = fsys.read(INDEX_PAGE).map(|b| {
            Bytes::from(replace_all(
                &b,
                ASSET_VER_PLACEHOLDER.as_bytes(),
                version.as_bytes(),
            ))
        });
        let index_etag = index.as_deref().map(hash_bytes).unwrap_or_default();
        let csp = csp_for(index.as_deref().unwrap_or_default());
        StaticHandler {
            fsys,
            version,
            csp,
            index,
            index_etag,
            etags: RwLock::new(HashMap::new()),
            blobs: RwLock::new(HashMap::new()),
        }
    }

    /// Go `ServeHTTP`.
    pub(crate) fn serve(&self, r: &Req) -> Response {
        let mut h = HeaderMap::new();
        set_security_headers(&mut h, &self.csp);
        let tag = self.etag_for(&r.path);
        if !tag.is_empty() {
            set(&mut h, header::ETAG, &tag);
        }
        // HTML 과 매니페스트는 항상 재검증한다 — `?v=` 로 무효화할 수 없다.
        if is_html_path(&r.path) || r.path.ends_with(".webmanifest") {
            set(&mut h, header::CACHE_CONTROL, "no-cache");
        }
        if let Some(index) = &self.index
            && r.path == "/"
        {
            return serve_content(r, h, INDEX_PAGE, index.clone());
        }
        let h = match self.serve_precompressed(r, h) {
            Ok(res) => return res,
            Err(h) => h,
        };
        self.file_server(r, h)
    }

    /// Go `gzName`: 논리 경로에 실제 파일이 있으면 그쪽이 진실이다.
    fn gz_name(&self, url_path: &str) -> String {
        let name = asset_name(url_path);
        if name.is_empty() || !valid_path(&name) {
            return String::new();
        }
        if self.fsys.is_file(&name) || self.fsys.read_dir(&name).is_some() {
            return String::new();
        }
        let gz = format!("{name}{GZ_SUFFIX}");
        if !self.fsys.is_file(&gz) {
            return String::new();
        }
        gz
    }

    /// Go `gzBlob`: 처음 한 번만 읽는다 (FR-PRF-50~52).
    fn gz_blob(&self, gz: &str) -> Option<Bytes> {
        if let Some(b) = self.blobs.read().unwrap_or_else(|e| e.into_inner()).get(gz) {
            return Some(b.clone());
        }
        let b = to_bytes(self.fsys.read(gz)?);
        self.blobs
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(gz.to_owned(), b.clone());
        Some(b)
    }

    /// Go `servePrecompressed`: `.gz` 로 담긴 자산을 낸다. 해당이 없으면 머리를 돌려준다.
    fn serve_precompressed(&self, r: &Req, mut h: HeaderMap) -> Result<Response, HeaderMap> {
        let gz = self.gz_name(&r.path);
        if gz.is_empty() {
            return Err(h);
        }
        let Some(data) = self.gz_blob(&gz) else {
            return Err(h);
        };
        let logical = gz.strip_suffix(GZ_SUFFIX).unwrap_or(&gz);
        set(&mut h, header::CONTENT_TYPE, &content_type_for(logical));
        set(&mut h, header::VARY, "Accept-Encoding");
        if accepts_gzip(r) {
            set(&mut h, header::CONTENT_ENCODING, "gzip");
            return Ok(serve_content(r, h, "", data));
        }
        // gzip 을 밝히지 않은 클라이언트에는 풀어서 준다 (FR-MVN-8).
        let mut plain = Vec::new();
        if flate2::read::MultiGzDecoder::new(&data[..])
            .read_to_end(&mut plain)
            .is_err()
        {
            return Ok(merge(
                h,
                http_err(
                    "corrupt asset",
                    StatusCode::INTERNAL_SERVER_ERROR,
                    apierr::CODE_CORRUPT_ASSET,
                ),
            ));
        }
        Ok(serve_content(r, h, "", Bytes::from(plain)))
    }

    /// Go `etagFor`: 경로의 내용 해시다. 디렉터리·없는 파일은 빈 값이다.
    pub(crate) fn etag_for(&self, url_path: &str) -> String {
        let mut name = asset_name(url_path);
        if name.is_empty() || url_path.ends_with('/') {
            name = path::join(&[name.as_str(), INDEX_PAGE]);
        }
        if !valid_path(&name) {
            return String::new();
        }
        // 문서는 치환된 것이 나간다 — 원본으로 판정하면 옛 `?v=` 가 남는다 (FR-AVS-7).
        if name == INDEX_PAGE && !self.index_etag.is_empty() {
            return self.index_etag.clone();
        }
        if let Some(t) = self
            .etags
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(&name)
        {
            return t.clone();
        }
        let mut tag = self.hash_file(&name);
        // 사전압축 자산의 검증자는 담긴 바이트의 것이다 (FR-MVN-10).
        if tag.is_empty() {
            tag = self.hash_file(&format!("{name}{GZ_SUFFIX}"));
        }
        if tag.is_empty() {
            return tag;
        }
        self.etags
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .insert(name, tag.clone());
        tag
    }

    #[cfg(test)]
    pub(crate) fn etag_count(&self) -> usize {
        self.etags.read().unwrap_or_else(|e| e.into_inner()).len()
    }

    fn hash_file(&self, name: &str) -> String {
        self.fsys
            .read(name)
            .map(|b| hash_bytes(&b))
            .unwrap_or_default()
    }

    /// Go `http.FileServer(http.FS(fsys))` 의 `serveFile(..., redirect=true)`.
    fn file_server(&self, r: &Req, h: HeaderMap) -> Response {
        let url = if r.path.starts_with('/') {
            r.path.clone()
        } else {
            format!("/{}", r.path)
        };
        if url.ends_with("/index.html") {
            return local_redirect(r, h, "./");
        }
        let name = path::clean(&url);
        let rel = if name == "/" {
            ".".to_owned()
        } else {
            name.strip_prefix('/').unwrap_or(&name).to_owned()
        };
        let is_dir = rel == "." || self.fsys.read_dir(&rel).is_some();
        if !is_dir && !self.fsys.is_file(&rel) {
            return serve_error(h, "404 page not found", StatusCode::NOT_FOUND);
        }
        if is_dir && !url.ends_with('/') {
            return local_redirect(r, h, &format!("{}/", path::base(&url)));
        }
        if !is_dir && url.ends_with('/') {
            let base = path::base(&url);
            if base == "/" || base == "." {
                return serve_error(
                    h,
                    "http: attempting to traverse a non-directory",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
            return local_redirect(r, h, &format!("../{base}"));
        }
        if !is_dir {
            return match self.fsys.read(&rel) {
                Some(b) => serve_content(r, h, &path::base(&rel), to_bytes(b)),
                None => serve_error(h, "404 page not found", StatusCode::NOT_FOUND),
            };
        }
        let index = format!("{}/{INDEX_PAGE}", name.trim_end_matches('/'));
        let index_rel = index.strip_prefix('/').unwrap_or(&index);
        if let Some(b) = self.fsys.read(index_rel) {
            return serve_content(r, h, INDEX_PAGE, to_bytes(b));
        }
        match self.fsys.read_dir(&rel) {
            Some(v) => dir_list(h, v.into_iter().map(|e| (e.name, e.is_dir)).collect()),
            None => go_error(
                h,
                "Error reading directory",
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
        }
    }
}

/// 보안 헤더 (04-secops §4.3). CSP 는 마크업 이스케이프 뒤의 그물이다.
fn set_security_headers(h: &mut HeaderMap, csp: &str) {
    set(h, header::CONTENT_SECURITY_POLICY, csp);
    set(h, header::X_FRAME_OPTIONS, "DENY");
    set(h, header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    set(h, header::REFERRER_POLICY, "no-referrer");
}

/// 앞서 쌓은 머리 위에 오류 응답을 얹는다 (Go 는 같은 `w.Header()` 에 쓴다).
fn merge(h: HeaderMap, mut res: Response) -> Response {
    for (k, v) in &h {
        if k != header::CONTENT_LENGTH && !res.headers().contains_key(k) {
            res.headers_mut().insert(k.clone(), v.clone());
        }
    }
    res
}

impl Server {
    /// mux 의 `/`. 정적 자산이 없는 구성이면 Go 처럼 `/` 가 등록되지 않은 것과 같다.
    pub(crate) async fn handle_static(&self, r: &mut Req) -> Response {
        match &self.statics {
            Some(h) => h.serve(r),
            None => httpresp::http_error(StatusCode::NOT_FOUND, "404 page not found"),
        }
    }
}
