//! 저장소 변화 감지용 서명 (FR-GIT-23·24). git 을 띄우지 않고 파일만 stat 한다.

use std::time::UNIX_EPOCH;

use otter_gocompat::filepath;
use otter_webserver_domain_git_core::{Ctx, Service};
use serde::Serialize;

use crate::error::Error;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Signature {
    pub head: String,
    #[serde(rename = "refName")]
    pub ref_name: String,
    #[serde(rename = "indexMtimeNs")]
    pub index_mtime_ns: i64,
    #[serde(rename = "indexSize")]
    pub index_size: i64,
    #[serde(rename = "refMtimeNs")]
    pub ref_mtime_ns: i64,
    #[serde(rename = "refsMtimeNs")]
    pub refs_mtime_ns: i64,
    #[serde(rename = "refsShape")]
    pub refs_shape: i64,
    pub extras: i64,
    pub value: String,
}

pub(crate) const HEAD_FILE: &str = "HEAD";
const INDEX_FILE: &str = "index";
const PACKED_REFS_FILE: &str = "packed-refs";
const REFS_DIR: &str = "refs";
pub(crate) const SYMREF_PREFIX: &str = "ref: ";
const SIG_SEP: &str = "|";
const REFS_WALK_MAX_DIRS: usize = 256;
const CONFIG_FILE: &str = "config";
const LOGS_REFS_STASH: &str = "logs/refs/stash";
const REFS_STASH: &str = "refs/stash";
const WORKTREES_DIR: &str = "worktrees";

pub async fn signature_of(s: &Service, ctx: &Ctx, repo: &str) -> Result<Signature, Error> {
    let (git_dir, common_dir) = s.git_dirs(ctx, repo).await?;
    read_signature(&git_dir, &common_dir)
}

pub fn read_signature(git_dir: &str, common_dir: &str) -> Result<Signature, Error> {
    let head_path = filepath::join(&[git_dir, HEAD_FILE]);
    let head = std::fs::read(&head_path).map_err(|e| Error::io("open", &head_path, e))?;
    let mut sig = Signature {
        head: String::from_utf8_lossy(&head).trim().to_owned(),
        ..Signature::default()
    };
    (sig.index_mtime_ns, sig.index_size) = stat_mtime_size(&filepath::join(&[git_dir, INDEX_FILE]));
    if let Some(rest) = sig.head.strip_prefix(SYMREF_PREFIX) {
        sig.ref_name = rest.trim().to_owned();
        let p = filepath::join(&[common_dir, filepath::from_slash(&sig.ref_name).as_str()]);
        sig.ref_mtime_ns = stat_mtime_size(&p).0;
        if sig.ref_mtime_ns == 0 {
            sig.ref_mtime_ns = stat_mtime_size(&filepath::join(&[common_dir, PACKED_REFS_FILE])).0;
        }
    }
    (sig.refs_mtime_ns, sig.refs_shape) = refs_tree(common_dir);
    sig.extras = extras_of(common_dir);
    sig.value = [
        sig.head.clone(),
        sig.index_mtime_ns.to_string(),
        sig.index_size.to_string(),
        sig.ref_name.clone(),
        sig.ref_mtime_ns.to_string(),
        sig.refs_mtime_ns.to_string(),
        sig.refs_shape.to_string(),
        sig.extras.to_string(),
    ]
    .join(SIG_SEP);
    Ok(sig)
}

fn extras_of(common_dir: &str) -> i64 {
    let mut sum: i64 = 0;
    let mut mix = |p: &str, salt: i64| {
        let (mt, size) = stat_mtime_size(&filepath::join(&[common_dir, p]));
        sum ^= mt.wrapping_add(size.wrapping_mul(31)).wrapping_add(salt);
    };
    mix(CONFIG_FILE, 1);
    mix(&filepath::from_slash(LOGS_REFS_STASH), 2);
    mix(&filepath::from_slash(REFS_STASH), 3);
    sum ^ dir_shape(&filepath::join(&[common_dir, WORKTREES_DIR]))
}

/// FNV-1a 64 (Go `hash/fnv.New64a`).
struct Fnv64a(u64);

impl Fnv64a {
    fn new() -> Self {
        Fnv64a(0xcbf2_9ce4_8422_2325)
    }

    fn write(&mut self, b: &[u8]) {
        for &c in b {
            self.0 ^= u64::from(c);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
}

/// Go `os.ReadDir`: 이름순 정렬, 심링크를 따르지 않는 종류.
fn read_dir_sorted(dir: &str) -> Option<Vec<(Vec<u8>, bool)>> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut v: Vec<(Vec<u8>, bool)> = rd
        .flatten()
        .map(|e| {
            let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
            (e.file_name().as_encoded_bytes().to_vec(), is_dir)
        })
        .collect();
    v.sort();
    Some(v)
}

fn mtime_ns(p: &str) -> Option<i64> {
    let m = std::fs::metadata(p).ok()?;
    let t = m.modified().ok()?;
    Some(match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_nanos() as i64,
        Err(e) => -(e.duration().as_nanos() as i64),
    })
}

fn dir_shape(dir: &str) -> i64 {
    let mut h = Fnv64a::new();
    if let Some(mt) = mtime_ns(dir) {
        h.write(mt.to_string().as_bytes());
    }
    if let Some(ents) = read_dir_sorted(dir) {
        for (name, _) in ents {
            h.write(&name);
            h.write(&[0]);
        }
    }
    h.0 as i64
}

fn refs_tree(common_dir: &str) -> (i64, i64) {
    let (mt, size) = stat_mtime_size(&filepath::join(&[common_dir, PACKED_REFS_FILE]));
    let mut sum = mt ^ size;
    let mut h = Fnv64a::new();
    let mut n = 0usize;
    fn walk(dir: &str, n: &mut usize, sum: &mut i64, h: &mut Fnv64a) {
        if *n >= REFS_WALK_MAX_DIRS {
            return;
        }
        let Some(ents) = read_dir_sorted(dir) else {
            return;
        };
        *n += 1;
        if let Some(mt) = mtime_ns(dir) {
            *sum ^= mt.wrapping_add(dir.len() as i64);
        }
        for (name, is_dir) in ents {
            h.write(&name);
            h.write(&[0]);
            if is_dir {
                let child = filepath::join(&[dir, String::from_utf8_lossy(&name).as_ref()]);
                walk(&child, n, sum, h);
            }
        }
        h.write(b"/");
    }
    walk(
        &filepath::join(&[common_dir, REFS_DIR]),
        &mut n,
        &mut sum,
        &mut h,
    );
    (sum, h.0 as i64)
}

fn stat_mtime_size(p: &str) -> (i64, i64) {
    let Ok(m) = std::fs::metadata(p) else {
        return (0, 0);
    };
    (mtime_ns(p).unwrap_or(0), m.len() as i64)
}
