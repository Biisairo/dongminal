//! Go `internal/shared/runtime` 테스트의 관측 동작 부분.

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime};

use otter_gocompat::json;
use serde_json::Value;

use super::*;

fn tmp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

/// 덧없지 않은 자기 경로. 내용은 상관없다.
fn fake_exe(dir: &Path) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    let p = dir.join(format!("otterminal{}", exe_suffix()));
    fs::write(&p, "#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
    }
    p
}

fn helper_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}{}", exe_suffix()))
}

/// 시험용 설치. 자기 경로는 덧없지 않은 가짜 실행 파일이다.
fn installed() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let root = tmp();
    let exe = fake_exe(&root.path().join("opt"));
    let bin = root.path().join("bin");
    install_with(&bin, &exe).unwrap();
    (root, bin, exe)
}

#[cfg(unix)]
fn mode(p: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

fn hook_commands(blob: &[u8]) -> BTreeMap<String, Vec<String>> {
    let v: Value = json::unmarshal(blob).unwrap();
    let mut out = BTreeMap::new();
    for (ev, groups) in v["hooks"].as_object().unwrap() {
        let cmds = groups
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|g| g["hooks"].as_array().unwrap().iter())
            .map(|h| h["command"].as_str().unwrap().to_owned())
            .collect();
        out.insert(ev.clone(), cmds);
    }
    out
}

#[test]
fn asset_list_matches_disk() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets");
    let mut disk = Vec::new();
    fn walk(dir: &Path, rel: &str, out: &mut Vec<String>) {
        let mut es: Vec<_> = fs::read_dir(dir).unwrap().map(Result::unwrap).collect();
        es.sort_by_key(fs::DirEntry::file_name);
        for e in es {
            let r = format!("{rel}{}", e.file_name().to_string_lossy());
            if e.file_type().unwrap().is_dir() {
                walk(&e.path(), &format!("{r}/"), out);
            } else {
                out.push(r);
            }
        }
    }
    walk(&root, "", &mut disk);
    let listed: Vec<_> = assets::ASSETS.iter().map(|a| a.path.to_owned()).collect();
    assert_eq!(listed, disk);
}

#[test]
fn install_writes_activity_hooks() {
    let (_r, bin, _) = installed();
    let blob = fs::read(bin.join("agent-hooks/claude.json")).unwrap();
    let want = InstallSpec {
        otterctl: otterctl_path(&bin),
        ..InstallSpec::default()
    }
    .hook_command(&["activity", "claude"]);
    let hooks = hook_commands(&blob);
    for ev in [
        "SessionStart",
        "SessionEnd",
        "UserPromptSubmit",
        "PreToolUse",
        "PostToolUse",
        "PreCompact",
        "SubagentStop",
        "Stop",
        "Notification",
        "PermissionRequest",
        "PostToolUseFailure",
        "SubagentStart",
        "StopFailure",
        "PostCompact",
    ] {
        assert_eq!(hooks[ev][0], want, "{ev}");
    }
    assert!(!String::from_utf8_lossy(&blob).contains("notify"));
    for cmds in hooks.values() {
        for c in cmds {
            assert!(
                c.starts_with(&format!("\"{}\"", otterctl_path(&bin)))
                    && c.matches('"').count() == 2,
                "{c}"
            );
        }
    }
}

#[cfg(unix)]
#[test]
fn install_helper_symlinks_and_shims() {
    let (_r, bin, exe) = installed();
    for n in otter_shared_otterenv::helper_names() {
        assert_eq!(fs::read_link(helper_path(&bin, n)).unwrap(), exe, "{n}");
    }
    let shim = otter_shared_otterenv::agent_shims_dir_in(&bin).join("claude");
    assert!(fs::metadata(&shim).unwrap().is_file());
    assert_eq!(fs::read_link(&shim).unwrap(), exe);
    assert_eq!(
        fs::read_to_string(bin.join(HELPER_MANIFEST)).unwrap(),
        "detach\ndownload\nedit\nopen-url\notterctl\n"
    );
    assert_eq!(
        fs::read_to_string(otter_shared_otterenv::agent_shims_dir_in(&bin).join(HELPER_MANIFEST))
            .unwrap(),
        "claude\n"
    );
    install_with(&bin, &exe).unwrap();
    assert!(inspect_helpers(&bin).problems.is_empty());
    fs::remove_file(&shim).unwrap();
    let st = inspect_helpers(&bin);
    assert_eq!(st.problems.len(), 1);
    assert_eq!(st.problems[0].name, "claude");
}

#[cfg(unix)]
#[test]
fn install_modes_and_layout() {
    let (_r, bin, _) = installed();
    for (rel, m) in [
        ("bash-hook.sh", 0o755),
        ("zdotdir/.zshrc", 0o644),
        ("agent-hooks/claude.json", 0o644),
        ("agent-hooks/omp-activity.mjs", 0o644),
        ("agent-hooks/omp-member.yml", 0o644),
        ("agent-plugin/.claude-plugin/plugin.json", 0o644),
        ("agent-plugin/commands/issue-tree.md", 0o644),
        ("agent-plugin/commands/migration.md", 0o644),
        ("agent-plugin/hooks/hooks.json", 0o644),
        ("agent-memory/CLAUDE.md", 0o644),
    ] {
        assert_eq!(mode(&bin.join(rel)), m, "{rel}");
    }
    for d in [
        "",
        "zdotdir",
        "agent-hooks",
        "agent-shims",
        "agent-plugin/hooks",
        "agent-memory",
    ] {
        assert_eq!(mode(&bin.join(d)), 0o755 & !umask(), "{d}");
    }
    assert!(
        !bin.join(otter_shared_platform::POWERSHELL_HOOK_FILE)
            .exists()
    );
    let entries: Vec<_> = fs::read_dir(agent_memory_dir(&bin)).unwrap().collect();
    assert_eq!(entries.len(), 1);
    let manifest: Value =
        json::unmarshal(&fs::read(bin.join("agent-plugin/.claude-plugin/plugin.json")).unwrap())
            .unwrap();
    assert_eq!(manifest["name"], "otterminal");
    let plugin = fs::read(bin.join("agent-plugin/hooks/hooks.json")).unwrap();
    let want = InstallSpec {
        otterctl: otterctl_path(&bin),
        ..InstallSpec::default()
    }
    .hook_command(&["agent-context", "claude"]);
    assert_eq!(hook_commands(&plugin)["SessionStart"], [want]);
    assert!(!String::from_utf8_lossy(&plugin).contains("activity claude"));
}

#[cfg(unix)]
fn umask() -> u32 {
    let d = tmp();
    let p = d.path().join("probe");
    fs::DirBuilder::new().create(&p).unwrap();
    0o777 & !mode(&p)
}

#[test]
fn install_overwrites_and_prunes_plugin_tree() {
    let (_r, bin, exe) = installed();
    let plugin = agent_plugin_dir(&bin);
    fs::write(plugin.join("commands/issue-tree.md"), "stale").unwrap();
    let stale = [
        "skills/team/scripts/build_prompt.py",
        "skills/team/references/prompt.md",
        "skills/gone/SKILL.md",
    ];
    for rel in stale {
        let p = plugin.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, "옛 자산").unwrap();
    }
    fs::write(bin.join("user-file.txt"), "사용자 파일").unwrap();
    fs::write(agent_memory_dir(&bin).join("extra.md"), "x").unwrap();
    install_with(&bin, &exe).unwrap();
    assert_ne!(
        fs::read(plugin.join("commands/issue-tree.md")).unwrap(),
        b"stale"
    );
    assert!(!plugin.join("skills").exists());
    assert!(!agent_memory_dir(&bin).join("extra.md").exists());
    for rel in [
        "commands/issue-tree.md",
        ".claude-plugin/plugin.json",
        "hooks/hooks.json",
    ] {
        assert!(plugin.join(rel).exists(), "{rel}");
    }
    for rel in ["user-file.txt", "agent-hooks/claude.json"] {
        assert!(bin.join(rel).exists(), "{rel}");
    }
    assert!(fs::symlink_metadata(helper_path(&bin, "otterctl")).is_ok());
}

/// FR-OPT-5-5: 셸 훅·자산을 되풀이해 써도 같은 파일은 교체되지 않는다.
#[test]
fn reinstall_keeps_unchanged_files() {
    let (_r, bin, exe) = installed();
    let stamp = SystemTime::UNIX_EPOCH + Duration::from_secs(946_684_800);
    let files = [
        bin.join("agent-hooks/claude.json"),
        bin.join("agent-plugin/hooks/hooks.json"),
        bin.join("agent-memory/CLAUDE.md"),
        bin.join(HELPER_MANIFEST),
    ];
    for p in &files {
        fs::File::options()
            .write(true)
            .open(p)
            .unwrap()
            .set_modified(stamp)
            .unwrap();
    }
    install_with(&bin, &exe).unwrap();
    for p in &files {
        assert_eq!(
            fs::metadata(p).unwrap().modified().unwrap(),
            stamp,
            "{}",
            p.display()
        );
    }
}

#[test]
fn ensure_installed_skips_installs_and_repairs() {
    let root = tmp();
    let bin = root.path().join("bin");
    ensure_installed(&bin).unwrap();
    let st = inspect_helpers(&bin);
    assert!(st.installed && st.problems.is_empty(), "{st:?}");
    // 헬퍼가 멀쩡하면 다시 돌지 않는다 — 헬퍼가 아닌 산출물이 되살아나지 않는다.
    fs::remove_dir_all(agent_memory_dir(&bin)).unwrap();
    ensure_installed(&bin).unwrap();
    assert!(!agent_memory_dir(&bin).exists());
    let victim = helper_path(&bin, otter_shared_otterenv::helper_names()[0]);
    fs::remove_file(&victim).unwrap();
    ensure_installed(&bin).unwrap();
    assert!(fs::symlink_metadata(&victim).is_ok());
}

#[test]
fn ephemeral_self_is_copied_and_survives() {
    let go_build = tempfile::Builder::new()
        .prefix("go-build")
        .tempdir()
        .unwrap();
    let exe = fake_exe(&go_build.path().join("b001").join("exe"));
    let root = tmp();
    let bin = root.path().join("bin");
    install_with(&bin, &exe).unwrap();
    drop(go_build);
    assert!(inspect_helpers(&bin).problems.is_empty());
    let copy = helper_path(&bin, SELF_COPY_NAME);
    assert!(copy.is_file());
    assert!(
        fs::read_to_string(bin.join(HELPER_MANIFEST))
            .unwrap()
            .contains("otterminal-self\n")
    );
    // 덧없지 않은 다음 설치가 자기 복사본을 거둔다 (FR-ATF-60).
    install_with(&bin, &fake_exe(&root.path().join("opt"))).unwrap();
    assert!(!copy.exists());
    let st = inspect_helpers(&bin);
    assert!(st.installed && st.problems.is_empty());
}

#[test]
fn stable_self_is_not_copied() {
    let (_r, bin, _) = installed();
    assert!(!helper_path(&bin, SELF_COPY_NAME).exists());
}

#[test]
fn is_ephemeral_exe_needs_both_conditions() {
    let tmp = resolve_path(&std::env::temp_dir().to_string_lossy());
    let t = Path::new(&tmp);
    assert!(is_ephemeral_exe(&t.join("go-build123/b001/exe/otterminal")));
    assert!(!is_ephemeral_exe(
        &t.join("otterminal-iso-9/bin/otterminal")
    ));
    assert!(!is_ephemeral_exe(Path::new("/opt/go-build/otterminal")));
    assert!(!is_ephemeral_exe(Path::new("/usr/local/bin/otterminal")));
}

#[cfg(unix)]
#[test]
fn inspect_finds_dangling_and_missing() {
    let d = tmp();
    let bin = d.path();
    let names = otter_shared_otterenv::helper_names();
    let gone = tmp().path().join("사라진-바이너리");
    std::os::unix::fs::symlink(&gone, helper_path(bin, names[0])).unwrap();
    for n in &names[2..] {
        fs::write(helper_path(bin, n), "x").unwrap();
    }
    let shims = otter_shared_otterenv::agent_shims_dir_in(bin);
    fs::create_dir_all(&shims).unwrap();
    fs::write(shims.join("claude"), "x").unwrap();
    let st = inspect_helpers(bin);
    assert!(st.installed);
    assert_eq!(st.problems.len(), 2, "{st:?}");
    assert_eq!(
        st.problems[0].reason,
        format!("가리키는 곳이 없습니다: {}", gone.display())
    );
    assert_eq!(st.problems[1].reason, "설치되지 않았습니다");
    fs::create_dir(helper_path(bin, names[1])).unwrap();
    assert_eq!(
        inspect_helpers(bin).problems[1].reason,
        "파일이 아니라 디렉터리입니다"
    );
}

#[test]
fn inspect_fresh_and_partial() {
    let d = tmp();
    for bin in [d.path().join("bin"), d.path().to_path_buf()] {
        assert_eq!(inspect_helpers(&bin), HelperStatus::default());
    }
    let names = otter_shared_otterenv::helper_names();
    fs::write(helper_path(d.path(), names[0]), "x").unwrap();
    let st = inspect_helpers(d.path());
    assert!(st.installed);
    assert_eq!(
        st.problems.len(),
        names.len() - 1 + agentadapter::shim_commands().len()
    );
}

#[test]
fn reaps_retired_and_dropped_names_but_not_unknown_or_paths() {
    let root = tmp();
    let exe = fake_exe(&root.path().join("opt"));
    let bin = root.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    fs::write(helper_path(&bin, "mdview"), "x").unwrap();
    install_with(&bin, &exe).unwrap();
    assert!(!helper_path(&bin, "mdview").exists());
    let sub = bin.join("sub");
    fs::create_dir_all(&sub).unwrap();
    let mut blob = fs::read(bin.join(HELPER_MANIFEST)).unwrap();
    let victims = [
        ("../outside", helper_path(root.path(), "outside")),
        ("sub/inner", helper_path(&sub, "inner")),
        ("sub\\inner2", helper_path(&sub, "inner2")),
    ];
    blob.extend_from_slice(b"..\n");
    for (line, p) in &victims {
        blob.extend_from_slice(format!("{line}\n").as_bytes());
        fs::write(p, "x").unwrap();
    }
    fs::write(helper_path(&bin, "옛헬퍼"), "x").unwrap();
    blob.extend_from_slice("옛헬퍼\n".as_bytes());
    fs::write(bin.join(HELPER_MANIFEST), blob).unwrap();
    let shims = otter_shared_otterenv::agent_shims_dir_in(&bin);
    fs::write(helper_path(&shims, "옛shim"), "x").unwrap();
    let mut sblob = fs::read(shims.join(HELPER_MANIFEST)).unwrap();
    sblob.extend_from_slice("옛shim\n".as_bytes());
    fs::write(shims.join(HELPER_MANIFEST), sblob).unwrap();
    fs::write(bin.join("사용자가-둔-것"), "x").unwrap();
    install_with(&bin, &exe).unwrap();
    assert!(!helper_path(&bin, "옛헬퍼").exists());
    assert!(!helper_path(&shims, "옛shim").exists());
    for (line, p) in &victims {
        assert!(p.exists(), "{line}");
    }
    assert!(bin.join("사용자가-둔-것").exists());
    let st = inspect_helpers(&bin);
    assert!(st.installed && st.problems.is_empty());
}

#[test]
fn both_hook_roots_unpack() {
    for (root, want, other) in [
        (
            "posix",
            vec!["bash-hook.sh", "zdotdir/.zshrc"],
            otter_shared_platform::POWERSHELL_HOOK_FILE,
        ),
        (
            "windows",
            vec![otter_shared_platform::POWERSHELL_HOOK_FILE],
            "bash-hook.sh",
        ),
    ] {
        let d = tmp();
        unpack_embedded(&format!("{SHELL_HOOK_ROOT}/{root}"), d.path()).unwrap();
        for w in want {
            assert!(fs::metadata(d.path().join(w)).unwrap().len() > 0, "{w}");
        }
        assert!(!d.path().join(other).exists());
    }
    let d = tmp();
    unpack_embedded("shellhooks/windows", d.path()).unwrap();
    let ps = fs::read(d.path().join(otter_shared_platform::POWERSHELL_HOOK_FILE)).unwrap();
    assert!(ps.starts_with(&[0xEF, 0xBB, 0xBF]));
    assert!(String::from_utf8_lossy(&ps).contains("HistorySavePath"));
}

#[test]
fn omp_assets_and_member_line_point_at_install() {
    let (_r, bin, _) = installed();
    let hooks = otter_shared_otterenv::agent_hooks_dir_in(&bin);
    let shim = fs::read_to_string(hooks.join(agentadapter::OMP_SHIM_FILE)).unwrap();
    let js = format!(
        "\"{}\"",
        otterctl_path(&bin)
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
    );
    assert!(shim.contains(&format!("const OTTERCTL = {js};")));
    assert!(shim.contains(r#""activity", "omp""#));
    let omp = agentadapter::get("omp").unwrap();
    let line = omp
        .launch_line(&hooks.to_string_lossy(), "", "프리앰블")
        .unwrap();
    let cfg = hooks.join(agentadapter::OMP_MEMBER_CONFIG_FILE);
    assert!(cfg.is_file());
    assert!(line.contains(&*cfg.to_string_lossy()), "{line}");
}

#[cfg(unix)]
#[test]
fn hook_command_runs_under_posix_shells() {
    use std::os::unix::fs::PermissionsExt;
    let d = tmp();
    let bin = d.path().join("My Tools").join("bin");
    fs::create_dir_all(&bin).unwrap();
    let otterctl = bin.join("otterctl");
    fs::write(&otterctl, "#!/bin/sh\necho \"CALLED args=$*\"\n").unwrap();
    fs::set_permissions(&otterctl, fs::Permissions::from_mode(0o755)).unwrap();
    install_agent_assets(&bin).unwrap();
    let cmd =
        hook_commands(&fs::read(bin.join("agent-hooks/claude.json")).unwrap())["Stop"][0].clone();
    for sh in ["sh", "bash", "zsh"] {
        let Some(sh) = otter_shared_platform::look_path(sh) else {
            continue;
        };
        let out = std::process::Command::new(sh)
            .args(["-c", &cmd])
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("CALLED args=activity claude"),
            "{out:?}"
        );
    }
}

/// FR-ADP-1: 레지스트리의 정책 주입 선언과 셸 래퍼가 어긋나지 않는다.
#[cfg(unix)]
#[test]
fn policy_injection_matches_shell_wrappers() {
    let (_r, bin, _) = installed();
    for rel in ["bash-hook.sh", "zdotdir/.zshrc"] {
        let s = fs::read_to_string(bin.join(rel)).unwrap();
        assert!(s.contains("OTTERMINAL_HOME"), "{rel}");
        for banned in [
            "$HOME/.claude",
            "~/.claude",
            "$HOME/.codex",
            "~/.codex",
            "AGENTS.md",
            "$HOME/.omp",
            "~/.omp",
            ".omp/agent",
        ] {
            assert!(!s.contains(banned), "{rel}: {banned}");
        }
        for id in agentadapter::ids() {
            let ad = agentadapter::get(id).unwrap();
            let func = format!("{}()", ad.detect_cmd);
            if ad.policy_injection.shim {
                assert!(!s.contains(&func), "{rel}: {id}");
                continue;
            }
            assert!(s.contains(&func), "{rel}: {id}");
            for f in ad.policy_injection.flags {
                assert!(s.contains(f), "{rel}: {id} {f}");
            }
            assert!(
                s.contains(&format!("command {}", ad.detect_cmd)),
                "{rel}: {id}"
            );
        }
    }
}

// FR-RDF-9: MkdirAll 은 gocompat 의 Go 알고리즘이다. 막힌 칸의 경로로 내고, `x/.` 도 만든다.
#[test]
fn mkdir_all_matches_go() {
    let d = tmp();
    let blocker = d.path().join("f");
    fs::write(&blocker, "x").unwrap();
    let bin = blocker.join("bin");
    let e = install_with(&bin, &blocker).unwrap_err();
    assert_eq!(
        go_error_string(&e),
        format!(
            "mkdir {}: mkdir {}: not a directory",
            bin.display(),
            blocker.display()
        )
    );
    let dot = format!("{}/new/.", d.path().display());
    mkdir_all(Path::new(&dot)).unwrap();
    assert!(d.path().join("new").is_dir());
}

// OTTERMINAL_RENAME_SRS FR-MIG-9: 옛 홈에서 넘어온 옛 제어 명령은 설치 기록이 없어도 지운다.
#[test]
fn reaps_legacy_control_helper() {
    let root = tmp();
    let exe = fake_exe(&root.path().join("opt"));
    let bin = root.path().join("bin");
    fs::create_dir_all(&bin).unwrap();
    fs::write(
        helper_path(&bin, otter_shared_otterenv::legacy::LEGACY_CONTROL_HELPER),
        "x",
    )
    .unwrap();
    install_with(&bin, &exe).unwrap();
    assert!(!helper_path(&bin, otter_shared_otterenv::legacy::LEGACY_CONTROL_HELPER).exists());
    assert!(helper_path(&bin, "otterctl").exists());
}

/// ISSUE_TREE_CHAT_SRS FR-LIS-1·2·9~15·18 (TC-ITH-17 의 문장 확인): 명령 문서가 네 조합과 로컬·coord 절차를 싣는다.
/// 프리앰블(`domain/run`)이 가리키는 절 이름(「로컬 이슈」·「일꾼 규칙」)도 여기 있어야 한다.
#[test]
fn issue_tree_doc_covers_local_and_coord() {
    let doc = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/agentplugin/commands/issue-tree.md"),
    )
    .unwrap();
    let hint = doc
        .lines()
        .find(|l| l.starts_with("argument-hint:"))
        .unwrap();
    for w in ["<폴더>#<ID>", "--mode tree|coord"] {
        assert!(hint.contains(w), "argument-hint: {w}");
    }
    for w in [
        "## 보관 방식과 실행 방식",
        "otterctl issue resolve",
        "github + tree",
        "github + coord",
        "local + tree",
        "local + coord",
        "## 로컬 이슈",
        "otterctl issue show",
        "otterctl issue tree",
        "otterctl issue new",
        "otterctl issue log",
        "--status blocked --reason",
        "--issue-dir",
        "<별칭>:<ID>",
        "## 조정자 절차",
        "--mode coord",
        "git worktree add",
        "<별칭>/<ID>",
        "--no-ff",
        "rust/target/debug/incremental",
        "df -h",
        "blockedBy",
        "## 일꾼 규칙",
        "상태는 원본 폴더만",
        "시험을 먼저",
        "문서와 코드가 다르면",
        "--status split",
        "다른 에이전트를 띄우지 않는다",
        "커밋이 막히면",
    ] {
        assert!(doc.contains(w), "issue-tree.md 에 없음: {w}");
    }
}

/// ISSUE_TREE_CHAT_SRS FR-ITR-1·4~10 (TC-ITH-17 의 문장 확인): 트리 방에서 상대를 call 로 불러 주고받는다.
#[test]
fn issue_tree_doc_covers_tree_room() {
    let doc = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/agentplugin/commands/issue-tree.md"),
    )
    .unwrap();
    for w in [
        "## 트리 방",
        "chat_create",
        "--chat-room",
        "chat_send",
        r#"call=["user"]"#,
        "보냄 → <상대>: <본문>",
        "받음 ← <보낸 이>: <요지>",
        "결정: <내용> (터미널에서|채팅에서)",
        "아무것도 하지 않고 턴을 끝낸다",
        "chat_leave",
        "promptFile",
    ] {
        assert!(doc.contains(w), "issue-tree.md 에 없음: {w}");
    }
}
