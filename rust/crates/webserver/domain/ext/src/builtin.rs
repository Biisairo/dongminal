//! 동봉된 **선언들**과 그 전개 (FR-EXT-34·35·36). 선언만 담는다 — 서버도 런타임도 배포물에 넣지
//! 않는다 (I-2).

use std::collections::BTreeMap;
use std::io;

use dm_gocompat::filepath;
use dm_gocompat::json;
use rust_embed::RustEmbed;

use crate::error::Error;
use crate::goos;
use crate::locate::plugin_dir;
use crate::manifest::{MANIFEST_NAME, Manifest, parse_manifest};

#[derive(RustEmbed)]
#[folder = "builtin/"]
#[include = "*.json"]
struct BuiltinFs;

/// 무엇을 이미 전개했는지의 기록. "지운 것을 되살리지 않는다" 의 근거다 (FR-EXT-36).
const DEPLOYED_NAME: &str = "deployed.json";

fn builtin_names() -> Vec<String> {
    let mut names: Vec<String> = BuiltinFs::iter().map(|n| n.into_owned()).collect();
    names.sort();
    names
}

/// 동봉된 선언들을 id 순으로 읽는다. 실패는 우리 잘못이다 (TC-EXT-60).
pub fn builtins() -> Result<Vec<Manifest>, Error> {
    let mut out = Vec::new();
    for name in builtin_names() {
        let Some(f) = BuiltinFs::get(&name) else {
            continue;
        };
        let m = parse_manifest(&f.data).map_err(|e| e.wrap(format!("동봉된 {name}")))?;
        out.push(m);
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// 그 팩의 원본 바이트. 다시 직렬화하지 않는다 — 손으로 적은 줄바꿈과 순서를 지킨다.
fn builtin_blob(id: &str) -> Result<Vec<u8>, Error> {
    let name = format!("{id}.json");
    BuiltinFs::get(&name)
        .map(|f| f.data.into_owned())
        .ok_or_else(|| Error::new(format!("open builtin/{name}: file does not exist")))
}

/// 전개 기록의 쓰기. 원자 쓰기다 (FR-ATF-27). 검사가 실패를 끼워 넣는 자리다.
pub(crate) type WriteDeployed = fn(&str, &[u8], u32) -> io::Result<()>;

fn write_atomic(p: &str, data: &[u8], perm: u32) -> io::Result<()> {
    dm_shared_platform::write_file_atomic(std::path::Path::new(p), data, perm)
}

/// 동봉 선언을 격리 칸으로 편다. 한 번만 펴고, 지운 것을 되살리지 않고, 실패는 그 팩만 죽인다.
pub fn deploy(root: &str) -> Vec<Error> {
    deploy_with(root, write_atomic)
}

pub(crate) fn deploy_with(root: &str, write_deployed: WriteDeployed) -> Vec<Error> {
    let ms = match builtins() {
        Ok(ms) => ms,
        Err(e) => return vec![e],
    };
    let mut done = match read_deployed(root) {
        Ok(d) => d,
        Err(e) => return vec![e],
    };
    let mut errs = Vec::new();
    // 이번 기동에 쓴 선언과 만든 자리. 기록이 실패하면 되돌린다.
    let mut wrote = Vec::new();
    let mut made_dirs = Vec::new();
    for m in ms {
        if done.contains_key(&m.id) {
            continue; // 이미 폈다 — 고쳤든 지웠든 사용자의 것이다
        }
        let blob = match builtin_blob(&m.id) {
            Ok(b) => b,
            Err(e) => {
                errs.push(e.wrap(&m.id));
                continue;
            }
        };
        let dir = plugin_dir(root, &m.id);
        if !goos::exists(&dir) {
            made_dirs.push(dir.clone());
        }
        if let Err(e) = goos::mkdir_all(&dir, 0o755) {
            errs.push(Error::from(e).wrap(format!("{}: 자리를 만들지 못했습니다", m.id)));
            continue;
        }
        let file = filepath::join(&[dir.as_str(), MANIFEST_NAME]);
        if let Err(e) = goos::write_file(&file, &blob, 0o644) {
            errs.push(Error::from(e).wrap(format!("{}: 선언을 쓰지 못했습니다", m.id)));
            continue;
        }
        wrote.push(file);
        done.insert(m.id.clone(), m.version.clone());
    }
    if !wrote.is_empty()
        && let Err(e) = write_deployed_record(root, &done, write_deployed)
    {
        // 기록 없이 선언만 남으면 다음 기동이 사용자 편집을 덮거나 지운 팩을 되살린다.
        for f in &wrote {
            let _ = goos::remove(f);
        }
        for d in &made_dirs {
            let _ = goos::remove(d);
        }
        errs.push(e);
    }
    errs
}

fn read_deployed(root: &str) -> Result<BTreeMap<String, String>, Error> {
    let p = filepath::join(&[root, DEPLOYED_NAME]);
    let blob = match goos::read_file(&p) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(e) => return Err(Error::from(e).wrap("전개 기록을 읽지 못했습니다")),
    };
    // 기록이 깨졌으면 비어 있는 것으로 보지 않는다 — 지운 팩이 되살아난다.
    let out: Option<BTreeMap<String, String>> = json::unmarshal(&blob).map_err(|e| {
        Error::new(e.to_string()).wrap(format!("전개 기록이 깨졌습니다 ({DEPLOYED_NAME})"))
    })?;
    Ok(out.unwrap_or_default())
}

fn write_deployed_record(
    root: &str,
    m: &BTreeMap<String, String>,
    write: WriteDeployed,
) -> Result<(), Error> {
    goos::mkdir_all(root, 0o755)?;
    let mut blob = json::marshal_indent(m, "", "  ").map_err(|e| Error::new(e.to_string()))?;
    blob.push(b'\n');
    write(&filepath::join(&[root, DEPLOYED_NAME]), &blob, 0o644)?;
    Ok(())
}
