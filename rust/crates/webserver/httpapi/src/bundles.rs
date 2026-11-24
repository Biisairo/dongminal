//! 묶음 `/b/<name>.js` (PERF_OPTIMIZATION_SRS D-29·D-33, `perf/M3_DESIGN.md` §3.4).
//!
//! 정의 파일 `bundles.txt` 의 순서대로 스크립트를 이어 붙인다. 소스 파일이 진실이고 생성 파일은
//! 없다. 서버가 설 때 한 번 만들고, gz 바이트는 처음 요청될 때 한 번 만든다.
//!
//! 정의 형식: 줄 단위. `#` 로 시작하는 줄과 빈 줄은 건너뛴다. `[이름]` 이 묶음을 연다.
//! 그 아래 `.js` 줄이 이어 붙일 파일(순서가 곧 로드 순서), `.css` 줄은 그 묶음의 CSS 다(서버는
//! 내지 않는다 — 화면 로더가 쓴다). 그 밖의 줄, 묶음 밖의 파일 줄, 같은 이름의 묶음이 있으면
//! 정의 전체를 버린다.

use std::collections::HashMap;
use std::io::Write;
use std::sync::OnceLock;

use bytes::Bytes;
use http::{HeaderMap, header};
use otter_shared_httpresp::Response;

use crate::req::Req;
use crate::serve_content::{serve_content, set};
use crate::static_assets::{StaticAssets, accepts_gzip, content_type_for, hash_bytes};

pub(crate) const BUNDLES_DEF: &str = "bundles.txt";

pub(crate) const BUNDLE_URL_PREFIX: &str = "/b/";

const JS_EXT: &str = ".js";
const MAP_EXT: &str = ".js.map";
const CSS_EXT: &str = ".css";
const VLQ_DIGITS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 정의의 묶음 하나: 이름과 이어 붙일 JS 파일(웹 뿌리 기준 경로).
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct BundleDef {
    pub(crate) name: String,
    pub(crate) js: Vec<String>,
}

/// 정의를 읽는다. 형식이 어긋나면 `None` 이다.
pub(crate) fn parse_bundles(text: &str) -> Option<Vec<BundleDef>> {
    let mut out: Vec<BundleDef> = Vec::new();
    for line in text.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            if name.is_empty() || out.iter().any(|b| b.name == name) {
                return None;
            }
            out.push(BundleDef {
                name: name.to_owned(),
                js: Vec::new(),
            });
            continue;
        }
        let cur = out.last_mut()?;
        if line.ends_with(JS_EXT) {
            cur.js.push(line.to_owned());
        } else if !line.ends_with(CSS_EXT) {
            return None;
        }
    }
    Some(out)
}

struct Bundle {
    js: Bytes,
    js_etag: String,
    map: Bytes,
    map_etag: String,
    gz: OnceLock<Bytes>,
}

/// 서버가 내는 묶음 전부.
pub(crate) struct Bundles(HashMap<String, Bundle>);

impl Bundles {
    pub(crate) fn build(fsys: &dyn StaticAssets) -> Bundles {
        let defs = fsys
            .read(BUNDLES_DEF)
            .and_then(|b| parse_bundles(&String::from_utf8_lossy(&b)))
            .unwrap_or_default();
        Bundles(
            defs.into_iter()
                .filter_map(|d| Some((d.name.clone(), concat(fsys, &d)?)))
                .collect(),
        )
    }

    /// 묶음 이름의 요청이면 답한다. 아니면 머리를 돌려준다.
    pub(crate) fn serve(&self, r: &Req, mut h: HeaderMap) -> Result<Response, HeaderMap> {
        let Some((b, is_map)) = self.find(&r.path) else {
            return Err(h);
        };
        if is_map {
            set(&mut h, header::ETAG, &b.map_etag);
            set(&mut h, header::CONTENT_TYPE, &content_type_for(MAP_EXT));
            return Ok(serve_content(r, h, "", b.map.clone()));
        }
        set(&mut h, header::ETAG, &b.js_etag);
        set(&mut h, header::CONTENT_TYPE, &content_type_for(JS_EXT));
        set(&mut h, header::VARY, "Accept-Encoding");
        if !accepts_gzip(r) {
            return Ok(serve_content(r, h, "", b.js.clone()));
        }
        set(&mut h, header::CONTENT_ENCODING, "gzip");
        let gz = b.gz.get_or_init(|| gzip(&b.js)).clone();
        Ok(serve_content(r, h, "", gz))
    }

    fn find(&self, url_path: &str) -> Option<(&Bundle, bool)> {
        let rest = url_path.strip_prefix(BUNDLE_URL_PREFIX)?;
        match rest.strip_suffix(MAP_EXT) {
            Some(n) => Some((self.0.get(n)?, true)),
            None => Some((self.0.get(rest.strip_suffix(JS_EXT)?)?, false)),
        }
    }
}

/// 파일 사이에 경계 줄을 두고 잇는다. 파일 하나라도 없으면 그 묶음은 없다.
fn concat(fsys: &dyn StaticAssets, def: &BundleDef) -> Option<Bundle> {
    let mut js = Vec::new();
    let mut lines: Vec<Option<(usize, usize)>> = Vec::new();
    for (i, path) in def.js.iter().enumerate() {
        let src = fsys.read(path)?;
        js.extend_from_slice(format!("/* ==== {path} ==== */\n").as_bytes());
        lines.push(None);
        js.extend_from_slice(&src);
        if !src.ends_with(b"\n") {
            js.push(b'\n');
        }
        let n = src.split(|c| *c == b'\n').count() - usize::from(src.ends_with(b"\n"));
        lines.extend((0..n).map(|l| Some((i, l))));
    }
    js.extend_from_slice(format!("//# sourceMappingURL={}{MAP_EXT}\n", def.name).as_bytes());
    lines.push(None);
    let map = source_map(def, &lines);
    Some(Bundle {
        js_etag: hash_bytes(&js),
        js: Bytes::from(js),
        map_etag: hash_bytes(map.as_bytes()),
        map: Bytes::from(map),
        gz: OnceLock::new(),
    })
}

/// 줄 오프셋만 담은 소스맵 v3. 묶음 줄마다 (원본 파일, 원본 줄, 0열) 하나다.
fn source_map(def: &BundleDef, lines: &[Option<(usize, usize)>]) -> String {
    let mut mappings = String::new();
    let (mut src, mut line) = (0i64, 0i64);
    for (k, l) in lines.iter().enumerate() {
        if k > 0 {
            mappings.push(';');
        }
        let Some((s, n)) = *l else {
            continue;
        };
        let (s, n) = (s as i64, n as i64);
        for v in [0, s - src, n - line, 0] {
            vlq(v, &mut mappings);
        }
        (src, line) = (s, n);
    }
    let sources: Vec<String> = def.js.iter().map(|p| format!("../{p}")).collect();
    serde_json::json!({
        "version": 3,
        "file": format!("{}{JS_EXT}", def.name),
        "sources": sources,
        "mappings": mappings,
    })
    .to_string()
}

fn vlq(v: i64, out: &mut String) {
    let mut n = if v < 0 { ((-v) << 1) | 1 } else { v << 1 };
    loop {
        let mut d = (n & 31) as usize;
        n >>= 5;
        if n > 0 {
            d |= 32;
        }
        out.push(VLQ_DIGITS[d] as char);
        if n == 0 {
            return;
        }
    }
}

fn gzip(b: &[u8]) -> Bytes {
    let mut w = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    if w.write_all(b).is_err() {
        return Bytes::new();
    }
    w.finish().map(Bytes::from).unwrap_or_default()
}
