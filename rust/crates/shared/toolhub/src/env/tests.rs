use std::collections::HashMap;
use std::fs;

use super::*;

struct Env(HashMap<String, String>);

impl Env {
    fn new(pairs: &[(&str, &str)]) -> Self {
        Self(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }
    fn get(&self, k: &str) -> String {
        self.0.get(k).cloned().unwrap_or_default()
    }
}

struct Homes {
    inst: tempfile::TempDir,
    tool: tempfile::TempDir,
}

impl Homes {
    fn new() -> Self {
        Self {
            inst: tempfile::tempdir().unwrap(),
            tool: tempfile::tempdir().unwrap(),
        }
    }
    fn env(&self) -> Env {
        Env::new(&[
            (otterenv::ENV_HOME, self.inst.path().to_str().unwrap()),
            (otterenv::ENV_TOOL_HOME, self.tool.path().to_str().unwrap()),
        ])
    }
}

fn hist(e: &Env, id: &str, shell: &str) -> HashMap<String, String> {
    tool_hist_env(&|k| e.get(k), id, shell)
        .into_iter()
        .map(|kv| {
            let (k, v) = kv.split_once('=').expect("=");
            (k.to_string(), v.to_string())
        })
        .collect()
}

#[test]
fn hist_file_per_tool_and_stable() {
    let h = Homes::new();
    let e = h.env();
    let a = hist(&e, "tool-a", "/bin/zsh");
    let b = hist(&e, "tool-b", "/bin/zsh");
    assert_ne!(a["HISTFILE"], b["HISTFILE"]);
    let want = h.inst.path().join(TOOL_HIST_DIR).join("tool-a.zsh");
    assert_eq!(a["HISTFILE"], want.to_str().unwrap());
    assert_eq!(hist(&e, "tool-a", "/bin/zsh")["HISTFILE"], a["HISTFILE"]);
    assert_eq!(a.len(), 2);
    assert_eq!(a[otterenv::ENV_HIST_FILE], a["HISTFILE"]);
}

#[test]
fn hist_file_seeds_once_and_never_overwrites() {
    let h = Homes::new();
    let e = h.env();
    fs::write(h.tool.path().join(".zsh_history"), "cmd_from_user\n").unwrap();
    let path = hist(&e, "tool-a", "/bin/zsh")["HISTFILE"].clone();
    assert_eq!(fs::read_to_string(&path).unwrap(), "cmd_from_user\n");
    fs::write(&path, "mine\n").unwrap();
    hist(&e, "tool-a", "/bin/zsh");
    assert_eq!(fs::read_to_string(&path).unwrap(), "mine\n");
    assert_eq!(
        fs::read_to_string(h.tool.path().join(".zsh_history")).unwrap(),
        "cmd_from_user\n"
    );
}

#[test]
fn hist_file_no_seed_source_creates_empty() {
    let h = Homes::new();
    let path = hist(&h.env(), "tool-a", "/bin/zsh")["HISTFILE"].clone();
    assert_eq!(fs::read(&path).unwrap(), b"");
}

#[test]
fn hist_file_per_shell_seeds_bash() {
    let h = Homes::new();
    let e = h.env();
    fs::write(h.tool.path().join(".bash_history"), "bash_cmd\n").unwrap();
    fs::write(h.tool.path().join(".zsh_history"), "zsh_cmd\n").unwrap();
    let z = hist(&e, "tool-a", "/bin/zsh")["HISTFILE"].clone();
    let b = hist(&e, "tool-a", "/bin/bash")["HISTFILE"].clone();
    assert_ne!(z, b);
    assert!(b.ends_with(".bash"));
    assert_eq!(fs::read_to_string(&b).unwrap(), "bash_cmd\n");
}

#[test]
fn hist_file_degrades() {
    let h = Homes::new();
    let e = h.env();
    let g = |k: &str| e.get(k);
    assert!(tool_hist_env(&g, "", "/bin/zsh").is_empty());
    for bad in ["..", ".", "a/b", "a\\b", "a\0b"] {
        assert!(tool_hist_env(&g, bad, "/bin/zsh").is_empty(), "{bad:?}");
    }
    let no_home = Env::new(&[]);
    assert!(tool_hist_env(&|k| no_home.get(k), "tool-a", "/bin/zsh").is_empty());
    let blocked = h.tool.path().join("blocked");
    fs::write(&blocked, "").unwrap();
    let be = Env::new(&[(otterenv::ENV_HOME, blocked.to_str().unwrap())]);
    assert!(tool_hist_env(&|k| be.get(k), "tool-a", "/bin/zsh").is_empty());
}

#[cfg(unix)]
#[test]
fn hist_file_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let h = Homes::new();
    let path = hist(&h.env(), "tool-a", "/bin/zsh")["HISTFILE"].clone();
    let mode = |p: &std::path::Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(std::path::Path::new(&path)), 0o600);
    assert_eq!(mode(&h.inst.path().join(TOOL_HIST_DIR)), 0o700);
}

#[test]
fn user_hist_file_rules() {
    let e = Env::new(&[("APPDATA", "C:/Users/foo/AppData/Roaming")]);
    for sh in ["powershell", "pwsh"] {
        let got = user_hist_file(&|k| e.get(k), sh).unwrap();
        let got = got.to_string_lossy();
        assert!(
            got.ends_with("ConsoleHost_history.txt") && got.contains("PSReadLine"),
            "{got}"
        );
    }
    let none = Env::new(&[]);
    assert!(user_hist_file(&|k| none.get(k), "powershell").is_none());
    let t = Env::new(&[(otterenv::ENV_TOOL_HOME, "/th")]);
    for sh in ["zsh", "bash"] {
        let want = filepath::join(&["/th", &format!(".{sh}_history")]);
        assert_eq!(
            user_hist_file(&|k| t.get(k), sh).unwrap().to_str().unwrap(),
            want
        );
    }
}

#[test]
fn tool_home_override_and_fallback() {
    let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let e = Env::new(&[(otterenv::ENV_TOOL_HOME, "/iso"), (home_key, "/u")]);
    assert_eq!(tool_home(&|k| e.get(k)), "/iso");
    let e = Env::new(&[(home_key, "/u")]);
    assert_eq!(tool_home(&|k| e.get(k)), "/u");
}

#[test]
fn bin_dir_and_path() {
    let none = Env::new(&[]);
    assert_eq!(tool_bin_dir(&|k| none.get(k)), "");
    let e = Env::new(&[(otterenv::ENV_HOME, "/h"), ("PATH", "/usr/bin")]);
    assert_eq!(tool_bin_dir(&|k| e.get(k)), filepath::join(&["/h", "bin"]));
    assert_eq!(tool_path(&|k| e.get(k), ""), "/usr/bin");
    let sep = if cfg!(windows) { ';' } else { ':' };
    assert_eq!(
        tool_path(&|k| e.get(k), "/x/bin"),
        format!("/usr/bin{sep}/x/bin")
    );
}

#[test]
fn browser_env_points_at_helper() {
    let got = tool_browser_env("/h/bin");
    let want = filepath::join(&["/h/bin", &format!("open-url{}", exe_suffix())]);
    assert_eq!(got, format!("BROWSER={want}"));
}

#[test]
fn shell_name_and_start_dir() {
    assert_eq!(hist_shell_name("/bin/zsh"), "zsh");
    assert_eq!(hist_shell_name("/usr/local/bin/Bash"), "bash");
    let d = tempfile::tempdir().unwrap();
    let home_key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let e = Env::new(&[(home_key, "/u")]);
    let g = |k: &str| e.get(k);
    assert_eq!(
        tool_start_dir(&g, d.path().to_str().unwrap()),
        d.path().to_str().unwrap()
    );
    assert_eq!(tool_start_dir(&g, "/no/such/dir"), "/u");
    let none = Env::new(&[]);
    assert_eq!(tool_start_dir(&|k| none.get(k), ""), ".");
}

fn ov(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[test]
fn overlay_getenv_prefers_overlay_last_wins() {
    let o = ov(&[(otterenv::ENV_HOME, "/a"), (otterenv::ENV_HOME, "/b")]);
    assert_eq!(overlay_getenv(&o, otterenv::ENV_HOME), "/b");
    // 덮지 않은 이름은 프로세스 환경이다.
    assert_eq!(
        overlay_getenv(&o, "PATH"),
        std::env::var("PATH").unwrap_or_default()
    );
    assert_eq!(overlay_getenv(&[], "OTTER_TEST_SURELY_UNSET_9f3"), "");
}

#[test]
fn environ_with_replaces_overlaid_keys_once() {
    let base = vec![
        "A=1".to_string(),
        format!("{}=/old", otterenv::ENV_HOME),
        "B=2".to_string(),
    ];
    let got = environ_with(base, &ov(&[(otterenv::ENV_HOME, "/new"), ("C", "3")]));
    assert_eq!(
        got,
        vec![
            "A=1".to_string(),
            "B=2".to_string(),
            format!("{}=/new", otterenv::ENV_HOME),
            "C=3".to_string(),
        ]
    );
    assert_eq!(
        environ_with(vec!["A=1".into()], &[]),
        vec!["A=1".to_string()]
    );
}

#[test]
fn tool_env_with_home_overlay_sets_bin_and_home() {
    let o = ov(&[(otterenv::ENV_HOME, "/inst")]);
    let g = |k: &str| overlay_getenv(&o, k);
    let bin = tool_bin_dir(&g);
    assert_eq!(bin, filepath::join(&["/inst", "bin"]));
    let env = tool_env(&g, "T1", "/bin/sh", &bin, &[], &[], &o);
    let homes: Vec<&String> = env
        .iter()
        .filter(|kv| kv.starts_with(&format!("{}=", otterenv::ENV_HOME)))
        .collect();
    assert_eq!(homes, vec![&format!("{}=/inst", otterenv::ENV_HOME)]);
    let path = env.iter().rev().find(|kv| kv.starts_with("PATH=")).unwrap();
    assert!(path.ends_with(&bin), "{path}");
}

// FR-RDF-9: 히스토리 디렉터리 로그의 오류는 Go os.MkdirAll 처럼 막힌 그 칸의 경로로 낸다.
#[test]
fn hist_dir_mkdir_error_matches_go() {
    let d = tempfile::tempdir().unwrap();
    let blocker = d.path().join("f");
    fs::write(&blocker, "x").unwrap();
    let dir = blocker.join("tool-history").to_string_lossy().into_owned();
    let e = mkdir_hist_dir(&dir).unwrap_err();
    assert_eq!(
        e.to_string(),
        format!("mkdir {}: not a directory", blocker.display())
    );
}
