//! 자산의 판 (Go `asset_version.go`, ASSET_VERSION_SINGLE_SOURCE_SRS 묶음 A).
//!
//! 브라우저로 나가는 자산은 `?v=` 로만 무효화된다. 판을 자산 자신의 내용에서 뽑으므로 올리는 것을
//! 잊을 수 없다.

use sha2::{Digest, Sha256};

use crate::static_assets::StaticAssets;

pub(crate) const INDEX_PAGE: &str = "index.html";

/// `index.html` 이 판을 적는 대신 비워 두는 자리다. 서빙 시점에 채운다 (FR-AVS-4·5).
pub(crate) const ASSET_VER_PLACEHOLDER: &str = "__ASSETV__";

/// 판의 길이다.
const ASSET_VER_LEN: usize = 12;

const VENDOR_PREFIX: &str = "vendor/";

/// Go `fs.WalkDir` 로 모은 파일 이름. 디렉터리를 읽지 못하면 `None` 이다.
fn walk_files(fsys: &dyn StaticAssets, dir: &str, out: &mut Vec<String>) -> Option<()> {
    let mut entries = fsys.read_dir(dir)?;
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    for e in entries {
        let p = if dir == "." {
            e.name
        } else {
            format!("{dir}/{}", e.name)
        };
        if e.is_dir {
            walk_files(fsys, &p, out)?;
        } else {
            out.push(p);
        }
    }
    Some(())
}

/// Go `computeAssetVersion`: JS·CSS 전부를 경로와 함께 하나의 판으로 접는다 (FR-AVS-1).
/// `vendor/` 는 빠지고(FR-AVS-1a) `index.html` 은 확장자로 저절로 빠진다(FR-AVS-1b).
pub(crate) fn compute_asset_version(fsys: &dyn StaticAssets) -> String {
    let mut all = Vec::new();
    if walk_files(fsys, ".", &mut all).is_none() {
        return String::new();
    }
    let mut names: Vec<String> = all
        .into_iter()
        .filter(|p| !p.starts_with(VENDOR_PREFIX))
        .filter(|p| matches!(dm_gocompat::path::ext(p), ".js" | ".css"))
        .collect();
    names.sort();
    let mut h = Sha256::new();
    for n in &names {
        let Some(b) = fsys.read(n) else {
            continue;
        };
        h.update(n.as_bytes());
        h.update([0u8]);
        h.update(&b);
    }
    let mut v = hex::encode(h.finalize());
    v.truncate(ASSET_VER_LEN);
    v
}
