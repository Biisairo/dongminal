use super::*;
use crate::env::{isolated_env, isolated_env_with_path};
use crate::locate::managed_exe;

fn root_of(env: &HashMap<String, String>) -> String {
    filepath::dir(&filepath::dir(&env["npm_config_cache"]))
}

#[test]
fn isolated_env_nothing_escapes_the_root() {
    let (_d, root) = tmp();
    let env = env_map(&isolated_env(&root, &must_parse(NPM_PACK)));
    for k in [
        "HOME",
        "USERPROFILE",
        "npm_config_cache",
        "npm_config_prefix",
        "GOMODCACHE",
        "GOCACHE",
        "GOBIN",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
    ] {
        let v = env.get(k).filter(|v| !v.is_empty());
        let v = v.unwrap_or_else(|| panic!("{k} 가 격리되지 않았다 (FR-EXT-21)"));
        assert!(
            under_root(&root, v),
            "{k}={v} 가 격리 칸 밖을 가리킨다 (FR-EXT-22)"
        );
    }
}

#[test]
fn isolated_env_clears_hostile_globals() {
    let (_d, root) = tmp();
    let env = env_map(&isolated_env(&root, &must_parse(GO_PACK)));
    for k in ["GOFLAGS", "NODE_OPTIONS", "NPM_CONFIG_PREFIX"] {
        assert_eq!(
            env.get(k).map(String::as_str),
            Some(""),
            "{k} 가 비워지지 않았다"
        );
    }
}

#[test]
fn isolated_env_npm_is_never_global() {
    let (_d, root) = tmp();
    let env = env_map(&isolated_env(&root, &must_parse(NPM_PACK)));
    assert_eq!(env["npm_config_global"], "false");
    let uc = &env["npm_config_userconfig"];
    assert!(!uc.is_empty() && under_root(&root_of(&env), uc));
}

#[test]
fn isolated_env_gobin_is_per_pack() {
    let (_d, r) = tmp();
    let a = env_map(&isolated_env(&r, &must_parse(GO_PACK)))["GOBIN"].clone();
    let b = env_map(&isolated_env(&r, &must_parse(NPM_PACK)))["GOBIN"].clone();
    assert_ne!(a, b, "두 팩이 같은 GOBIN 을 쓴다");
    let m = must_parse(GO_PACK);
    assert_eq!(a, filepath::dir(&managed_exe(&r, &m, &m.servers[0])));
}

#[test]
fn isolated_env_prepends_path() {
    let (_d, root) = tmp();
    let first = filepath::join(&[root.as_str(), "runtimes", "node-x", "bin"]);
    let env = env_map(&isolated_env_with_path(
        &root,
        &must_parse(NPM_PACK),
        std::slice::from_ref(&first),
        "/usr/bin",
    ));
    let got = &env["PATH"];
    let head = got.split(filepath::LIST_SEPARATOR).next().unwrap();
    assert!(
        under_root(&root, head),
        "PATH 의 첫 자리가 우리 것이 아니다: {got}"
    );
    assert!(got.contains("/usr/bin"), "기존 PATH 가 사라졌다: {got}");
}

/// 값과 순서가 Go 와 같다 — 자식 프로세스가 보는 환경이다.
#[test]
fn isolated_env_exact_layout() {
    let root = "/r";
    let got = isolated_env_with_path(root, &must_parse(GO_PACK), &["/p".to_owned()], "/usr/bin");
    let sep = filepath::LIST_SEPARATOR;
    let want: Vec<String> = [
        "HOME=/r/cache/home",
        "USERPROFILE=/r/cache/home",
        "XDG_CACHE_HOME=/r/cache/xdg/cache",
        "XDG_CONFIG_HOME=/r/cache/xdg/config",
        "XDG_DATA_HOME=/r/cache/xdg/data",
        "npm_config_cache=/r/cache/npm",
        "npm_config_prefix=/r/plugins/gopls",
        "npm_config_userconfig=/r/cache/npm/npmrc",
        "npm_config_global=false",
        "GOMODCACHE=/r/cache/gomod",
        "GOCACHE=/r/cache/gobuild",
        "GOBIN=/r/plugins/gopls/bin",
        "GOFLAGS=",
        "NODE_OPTIONS=",
        "NPM_CONFIG_PREFIX=",
    ]
    .iter()
    .map(|s| filepath::from_slash(s))
    .chain(std::iter::once(format!("PATH=/p{sep}/usr/bin")))
    .collect();
    if cfg!(unix) {
        assert_eq!(got, want);
    }
}
