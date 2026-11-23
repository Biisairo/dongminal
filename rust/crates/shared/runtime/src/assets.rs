//! 임베드 자산. Go 의 `//go:embed all:shellhooks` · `all:agentplugin` · `agentmemory` 와 같은 트리다.
//! 경로는 `assets/` 아래의 슬래시 경로다. 목록과 디스크가 같은지는 시험이 지킨다.

pub(crate) struct Asset {
    pub(crate) path: &'static str,
    pub(crate) data: &'static [u8],
}

macro_rules! assets {
    ($($p:literal),* $(,)?) => {
        &[$(Asset { path: $p, data: include_bytes!(concat!("../assets/", $p)) }),*]
    };
}

/// 경로 순으로 둔다 (Go `fs.WalkDir` 의 순서).
pub(crate) static ASSETS: &[Asset] = assets![
    "agentmemory/CLAUDE.md",
    "agentplugin/.claude-plugin/plugin.json",
    "agentplugin/commands/issue-tree.md",
    "agentplugin/commands/migration.md",
    "shellhooks/posix/bash-hook.sh",
    "shellhooks/posix/zdotdir/.zshrc",
    "shellhooks/windows/powershell-hook.ps1",
];

/// root 아래의 (root 기준 상대 경로, 내용).
pub(crate) fn under(root: &str) -> impl Iterator<Item = (&'static str, &'static [u8])> + '_ {
    ASSETS.iter().filter_map(move |a| {
        a.path
            .strip_prefix(root)
            .and_then(|r| r.strip_prefix('/'))
            .map(|r| (r, a.data))
    })
}
