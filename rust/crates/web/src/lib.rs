//! Go 기준선 `web` 의 Rust 포팅: 브라우저로 서빙할 정적 자산을 바이너리에 싣는다 (RUST_PORT_SRS FR-RSP-12).
//!
//! 싣는 파일 집합은 Go `web/embed.go` 의 `//go:embed` 패턴과 같다:
//! `*.html *.css *.webmanifest vendor/* js/*/*.js js/core/base/*.js assets/*`.
//! 디렉터리를 가리키는 패턴(`vendor/*`·`assets/*` 의 하위 디렉터리)은 그 아래를 통째로 싣되,
//! Go 처럼 `.`·`_` 로 시작하는 이름은 뺀다.

use std::borrow::Cow;
use std::collections::BTreeSet;

#[derive(rust_embed::Embed)]
#[folder = "../../../web/"]
#[include = "*.html"]
#[include = "*.css"]
#[include = "*.webmanifest"]
#[include = "vendor/**"]
#[include = "js/*/*.js"]
#[include = "js/core/base/*.js"]
#[include = "assets/**"]
#[exclude = "vendor/**/.*"]
#[exclude = "vendor/**/_*"]
#[exclude = "assets/**/.*"]
#[exclude = "assets/**/_*"]
struct Assets;

/// `path`(슬래시 구분, 앞 `/` 없음) 의 파일 바이트. 없으면 `None`.
pub fn get(path: &str) -> Option<Cow<'static, [u8]>> {
    Assets::get(path).map(|f| f.data)
}

/// 실린 모든 파일 경로(사전순).
pub fn paths() -> Vec<String> {
    let mut v: Vec<String> = Assets::iter().map(|p| p.into_owned()).collect();
    v.sort();
    v
}

/// 디렉터리 항목 하나. Go `fs.DirEntry` 의 이름·디렉터리 여부에 대응한다.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// `dir` 바로 아래 항목(이름순). `dir` 가 `""` 이면 뿌리다. 없는 디렉터리면 `None`.
pub fn read_dir(dir: &str) -> Option<Vec<DirEntry>> {
    let prefix = if dir.is_empty() {
        String::new()
    } else {
        format!("{}/", dir.trim_end_matches('/'))
    };
    let mut set = BTreeSet::new();
    for p in Assets::iter() {
        let Some(rest) = p.strip_prefix(prefix.as_str()) else {
            continue;
        };
        match rest.split_once('/') {
            Some((d, _)) => set.insert(DirEntry {
                name: d.to_string(),
                is_dir: true,
            }),
            None => set.insert(DirEntry {
                name: rest.to_string(),
                is_dir: false,
            }),
        };
    }
    if set.is_empty() {
        None
    } else {
        Some(set.into_iter().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icon_assets_embedded() {
        for n in [
            "assets/brand/otter-15.svg",
            "assets/favicon-16.png",
            "assets/favicon-32.png",
            "assets/apple-touch-icon.png",
            "assets/icon-192.png",
            "assets/icon-512.png",
        ] {
            assert!(get(n).is_some_and(|b| !b.is_empty()), "{n} 임베드 안 됨");
        }
    }

    #[test]
    fn vendor_dirs_are_only_codemirror() {
        let dirs: Vec<String> = read_dir("vendor")
            .expect("vendor")
            .into_iter()
            .filter(|e| e.is_dir)
            .map(|e| e.name)
            .collect();
        assert_eq!(dirs, vec!["codemirror".to_string()]);
    }

    #[test]
    fn base_classes_embedded() {
        for n in [
            "js/core/base/component.js",
            "js/core/base/view.js",
            "js/core/base/controller.js",
            "js/core/base/escape-stack.js",
            "js/core/base/scroll-memo.js",
            "js/core/base/badge.js",
        ] {
            assert!(get(n).is_some(), "{n} 임베드 안 됨");
        }
    }

    #[test]
    fn settings_schema_source_embedded() {
        assert!(get("js/core/settings-schema.js").is_some());
    }

    const ASSET_VER_PLACEHOLDER: &str = "__ASSETV__";

    /// 따옴표 안의 `?v=` 값 전부다 — Go `\?v=([^"'\s>]*)` 와 같다.
    fn asset_versions(doc: &str) -> Vec<&str> {
        doc.match_indices("?v=")
            .map(|(i, m)| {
                let rest = &doc[i + m.len()..];
                let end = rest
                    .find(|c: char| matches!(c, '"' | '\'' | '>') || c.is_ascii_whitespace())
                    .unwrap_or(rest.len());
                &rest[..end]
            })
            .collect()
    }

    // TC-AVS-9 (FR-AVS-4·15): 문서는 판을 적지 않는다. 판은 서버가 서빙 시점에 넣는다.
    #[test]
    fn index_declares_no_literal_version() {
        let b = get("index.html").expect("index.html");
        let doc = std::str::from_utf8(&b).expect("utf-8");
        let vs = asset_versions(doc);
        assert!(
            !vs.is_empty(),
            "index.html 에 ?v= 가 없다 — 자산이 무효화되지 않는다"
        );
        for v in vs {
            assert_eq!(v, ASSET_VER_PLACEHOLDER, "index.html 이 판을 손으로 적었다");
        }
    }

    #[test]
    fn asset_versions_catches_literal() {
        let doc = "<link href=\"a.css?v=__ASSETV__\"><script src='b.js?v=12'></script> c?v=x>";
        assert_eq!(asset_versions(doc), vec!["__ASSETV__", "12", "x"]);
    }

    #[test]
    fn go_sources_and_tests_are_not_embedded() {
        assert!(get("embed.go").is_none());
        assert!(paths().iter().all(|p| !p.ends_with(".go")));
    }
}
