//! 격리 칸의 플러그인들을 읽는다 (FR-EXT-1·2·8).

use std::io;

use otter_gocompat::filepath;
use otter_gocompat::strconv::quote;

use crate::error::{Error, errorf};
use crate::goos;
use crate::locate::plugins_dir;
use crate::manifest::{
    KIND_RUNTIME, KIND_SERVER, MANIFEST_NAME, Manifest, Server, normalize_ext, parse_manifest,
};

/// 격리 칸의 플러그인들을 id 순으로 읽는다. 오류는 **모아서** 낸다 — 깨진 팩만 빠진다 (FR-EXT-8).
pub fn load(root: &str) -> (Vec<Manifest>, Vec<Error>) {
    let dir = plugins_dir(root);
    let entries = match goos::read_dir(&dir) {
        Ok(e) => e,
        // 플러그인이 하나도 없는 상태는 정상이다 (FR-EXT-16).
        Err(e) if e.kind() == io::ErrorKind::NotFound => return (Vec::new(), Vec::new()),
        Err(e) => {
            return (
                Vec::new(),
                vec![Error::from(e).wrap("플러그인 디렉터리를 읽지 못했습니다")],
            );
        }
    };
    let mut out = Vec::new();
    let mut errs = Vec::new();
    for (id, is_dir) in entries {
        if !is_dir {
            continue;
        }
        let file = filepath::join(&[dir.as_str(), &id, MANIFEST_NAME]);
        let blob = match goos::read_file(&file) {
            Ok(b) => b,
            // 선언이 없는 디렉터리는 팩이 아니다. 조달이 남긴 곁다리일 수 있다.
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => {
                errs.push(Error::from(e).wrap(format!("{id}: 선언을 읽지 못했습니다")));
                continue;
            }
        };
        let m = match parse_manifest(&blob) {
            Ok(m) => m,
            Err(e) => {
                errs.push(e.wrap(&id));
                continue;
            }
        };
        // 자리를 정하는 것은 id 다. 디렉터리 이름과 어긋나면 받아 두고도 못 찾는다.
        if m.id != id {
            errs.push(errorf!(
                "{id}: 선언의 id 가 디렉터리와 다릅니다: {}",
                quote(&m.id)
            ));
            continue;
        }
        out.push(m);
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    (out, errs)
}

/// 런타임 팩만 (FR-EXT-6).
pub fn runtimes(ms: &[Manifest]) -> Vec<Manifest> {
    ms.iter()
        .filter(|m| m.kind == KIND_RUNTIME)
        .cloned()
        .collect()
}

/// 서버를 내는 팩들.
pub fn packs(ms: &[Manifest]) -> Vec<Manifest> {
    ms.iter()
        .filter(|m| m.kind == KIND_SERVER)
        .cloned()
        .collect()
}

/// 확장자를 (팩, 서버) 로 푼다. 어느 팩에도 없으면 세션을 세우지 않는다.
pub fn server_for_ext(ms: &[Manifest], ext: &str) -> Option<(Manifest, Server)> {
    let e = normalize_ext(ext);
    if e.is_empty() {
        return None;
    }
    ms.iter().filter(|m| m.kind == KIND_SERVER).find_map(|m| {
        m.servers
            .iter()
            .find(|s| s.exts.contains(&e))
            .map(|s| (m.clone(), s.clone()))
    })
}
