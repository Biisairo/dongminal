//! 조달과 실행이 쓸 격리 환경 (FR-EXT-21). 여기서 빠지는 변수 하나가 곧 남의 기계에 남는 흔적
//! 하나다.

use dm_gocompat::filepath;

use crate::locate::{cache_dir, plugin_dir};
use crate::manifest::Manifest;

// 캐시 칸의 하위 자리들. 정리(FR-EXT-23)가 한쪽만 지울 수 있게 도구마다 가른다.
const CACHE_HOME: &str = "home";
const CACHE_NPM: &str = "npm";
const CACHE_GO_MOD: &str = "gomod";
pub(crate) const CACHE_GO_BUILD: &str = "gobuild";
const CACHE_XDG: &str = "xdg";

/// toolchain 조달물이 놓이는 팩 안 자리의 기본값.
const TOOLCHAIN_BIN_SUB: &str = "bin";

/// `KEY=VALUE` 들. 호스트 환경 **뒤에** 붙여 쓴다 — 뒤가 이긴다.
pub fn isolated_env(root: &str, m: &Manifest) -> Vec<String> {
    let path = std::env::var("PATH").unwrap_or_default();
    isolated_env_with_path(root, m, &[], &path)
}

/// PATH 앞에 세울 자리들(런타임의 bin)을 함께 받는다.
pub fn isolated_env_with_path(
    root: &str,
    m: &Manifest,
    prepend: &[String],
    base_path: &str,
) -> Vec<String> {
    let cache = cache_dir(root);
    let c = |sub: &[&str]| {
        let mut parts = vec![cache.as_str()];
        parts.extend_from_slice(sub);
        filepath::join(&parts)
    };
    let home = c(&[CACHE_HOME]);
    let mut env = vec![
        // 홈을 정하는 변수가 OS 마다 다르므로 둘 다 심는다 (FR-XPL-5).
        format!("HOME={home}"),
        format!("USERPROFILE={home}"),
        format!("XDG_CACHE_HOME={}", c(&[CACHE_XDG, "cache"])),
        format!("XDG_CONFIG_HOME={}", c(&[CACHE_XDG, "config"])),
        format!("XDG_DATA_HOME={}", c(&[CACHE_XDG, "data"])),
        format!("npm_config_cache={}", c(&[CACHE_NPM])),
        format!("npm_config_prefix={}", plugin_dir(root, &m.id)),
        format!("npm_config_userconfig={}", c(&[CACHE_NPM, "npmrc"])),
        "npm_config_global=false".to_owned(),
        format!("GOMODCACHE={}", c(&[CACHE_GO_MOD])),
        format!("GOCACHE={}", c(&[CACHE_GO_BUILD])),
        format!("GOBIN={}", managed_bin_dir(root, m)),
        // 사용자의 전역 설정이 우리 조달을 막지 않게 한다.
        "GOFLAGS=".to_owned(),
        "NODE_OPTIONS=".to_owned(),
        // 대문자 쪽은 npm 이 따로 본다.
        "NPM_CONFIG_PREFIX=".to_owned(),
    ];
    let mut parts: Vec<&str> = prepend.iter().map(String::as_str).collect();
    parts.push(base_path);
    let sep = filepath::LIST_SEPARATOR.to_string();
    env.push(format!("PATH={}", parts.join(&sep)));
    env
}

/// toolchain 조달물이 놓일 자리. 탐색과 조달이 이 하나를 쓴다 (FR-EXT-19).
pub fn managed_bin_dir(root: &str, m: &Manifest) -> String {
    let sub = if m.source.bin.is_empty() {
        TOOLCHAIN_BIN_SUB
    } else {
        m.source.bin.as_str()
    };
    filepath::join(&[
        plugin_dir(root, &m.id).as_str(),
        filepath::from_slash(sub).as_str(),
    ])
}
