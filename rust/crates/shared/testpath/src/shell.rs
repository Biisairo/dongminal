use std::collections::BTreeMap;
use std::path::PathBuf;

/// 검사가 아는 셸의 이름 → 경로다.
const POSIX_SHELLS: [(&str, &str); 3] = [
    ("bash", "/bin/bash"),
    ("sh", "/bin/sh"),
    ("zsh", "/bin/zsh"),
];

/// 테스트가 띄우는 셸의 후보 순서다 — 앞의 것이 있으면 그것이다.
const PINNED_SHELLS: [&str; 2] = ["bash", "sh"];

fn shell_path(name: &str) -> Option<PathBuf> {
    if cfg!(windows) {
        return None;
    }
    let (_, path) = POSIX_SHELLS.iter().find(|(n, _)| *n == name)?;
    let p = PathBuf::from(path);
    p.exists().then_some(p)
}

/// 테스트가 띄우는 셸로 고정할 `$SHELL` 값이다 (M8 D-A-21). Windows 는 `None` 이다 —
/// 그쪽의 셸은 `OTTERMINAL_SHELL` 이고 `$SHELL` 을 보지 않는다.
pub fn pinned_shell() -> Option<PathBuf> {
    PINNED_SHELLS.iter().find_map(|n| shell_path(n))
}

/// 이 호스트에 있는 검사 대상 셸이다 — 이름 → 경로. Windows 에서는 비어 있다.
pub fn shells() -> BTreeMap<&'static str, PathBuf> {
    ["bash", "zsh"]
        .into_iter()
        .filter_map(|n| shell_path(n).map(|p| (n, p)))
        .collect()
}
