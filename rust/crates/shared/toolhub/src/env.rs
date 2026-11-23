//! 도구 셸의 환경과 도구별 히스토리 (TOOL_HISTORY_ISOLATION_SRS).

use std::fs::OpenOptions;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use dm_gocompat::filepath;
use dm_shared_dmenv as dmenv;
use dm_shared_dmlog::infof;

/// 인스턴스 홈 아래에서 도구 히스토리가 사는 자리다 (D-4).
pub(crate) const TOOL_HIST_DIR: &str = "tool-history";

/// 환경 조회다. 검사가 프로세스 환경을 바꾸지 않고 값을 주입하는 자리다.
pub(crate) type Getenv<'a> = &'a dyn Fn(&str) -> String;

/// 프로세스 환경이다. 없으면 "".
pub(crate) fn os_getenv(k: &str) -> String {
    std::env::var(k).unwrap_or_default()
}

/// 프로세스 환경 위에 덮개를 얹은 조회다. 같은 이름이 여럿이면 나중 것이 이긴다.
pub(crate) fn overlay_getenv(overlay: &[(String, String)], k: &str) -> String {
    match overlay.iter().rev().find(|(ok, _)| ok == k) {
        Some((_, v)) => v.clone(),
        None => os_getenv(k),
    }
}

/// base 에서 덮개가 가진 이름을 빼고 덮개를 뒤에 붙인다. 같은 이름이 두 번 실리면 셸에 따라
/// 앞의 값을 읽으므로 한 번만 남긴다.
pub(crate) fn environ_with(base: Vec<String>, overlay: &[(String, String)]) -> Vec<String> {
    let covered = |kv: &str| {
        let k = kv.split_once('=').map_or(kv, |(k, _)| k);
        overlay.iter().any(|(ok, _)| ok == k)
    };
    let mut env: Vec<String> = base.into_iter().filter(|kv| !covered(kv)).collect();
    for (i, (k, v)) in overlay.iter().enumerate() {
        if !overlay[i + 1..].iter().any(|(nk, _)| nk == k) {
            env.push(format!("{k}={v}"));
        }
    }
    env
}

/// Go `os.UserHomeDir` — unix `$HOME`, Windows `%USERPROFILE%`. 모르면 "".
fn user_home(g: Getenv) -> String {
    g(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
}

/// 도구 셸이 자기 홈으로 여길 곳이다. `DONGMINAL_TOOL_HOME` 이 우선한다.
pub(crate) fn tool_home(g: Getenv) -> String {
    let v = g(dmenv::ENV_TOOL_HOME);
    if v.is_empty() { user_home(g) } else { v }
}

/// `$DONGMINAL_HOME/bin`. 홈을 모르면 "".
pub(crate) fn tool_bin_dir(g: Getenv) -> String {
    let home = g(dmenv::ENV_HOME);
    if home.is_empty() {
        return String::new();
    }
    filepath::join(&[home.as_str(), dmenv::BIN_DIR])
}

pub(crate) fn tool_path(g: Getenv, bin_dir: &str) -> String {
    let base = g("PATH");
    if bin_dir.is_empty() {
        return base;
    }
    let sep = if cfg!(windows) { ';' } else { ':' };
    format!("{base}{sep}{bin_dir}")
}

fn exe_suffix() -> &'static str {
    dm_shared_platform::current().paths.exe_suffix()
}

/// 도구 셸의 BROWSER 다 (VIEWER_URL_OPEN_SRS FR-VUO-13).
pub(crate) fn tool_browser_env(bin_dir: &str) -> String {
    let name = format!("open-url{}", exe_suffix());
    format!("BROWSER={}", filepath::join(&[bin_dir, name.as_str()]))
}

/// Go `user.Current().Username`. unix 는 passwd 항목, 없으면 `$USER`. Windows 는 `DOMAIN\user`.
fn current_username(g: Getenv) -> Option<String> {
    #[cfg(unix)]
    {
        if let Ok(Some(u)) = nix::unistd::User::from_uid(nix::unistd::getuid()) {
            return Some(u.name);
        }
        let u = g("USER");
        (!u.is_empty()).then_some(u)
    }
    #[cfg(windows)]
    {
        let (d, u) = (g("USERDOMAIN"), g("USERNAME"));
        if u.is_empty() {
            return None;
        }
        Some(if d.is_empty() { u } else { format!("{d}\\{u}") })
    }
}

/// 도구 셸의 환경이다. 프로세스 환경이 앞, 도구 기본값이 뒤, 호출자의 추가 환경이 맨 뒤다.
pub(crate) fn tool_env(
    g: Getenv,
    id: &str,
    shell: &str,
    bin_dir: &str,
    shell_env: &[String],
    extra_env: &[String],
    overlay: &[(String, String)],
) -> Vec<String> {
    let base: Vec<String> = std::env::vars_os()
        .map(|(k, v)| format!("{}={}", k.to_string_lossy(), v.to_string_lossy()))
        .collect();
    let mut env = environ_with(base, overlay);
    env.extend([
        "TERM=xterm-256color".to_string(),
        "COLORTERM=truecolor".to_string(),
        format!("PATH={}", tool_path(g, bin_dir)),
        format!("HOME={}", tool_home(g)),
        format!("{}={id}", dmenv::ENV_TOOL_ID),
        tool_browser_env(bin_dir),
    ]);
    if let Some(u) = current_username(g) {
        env.push(format!("USER={u}"));
        env.push(format!("LOGNAME={u}"));
    }
    env.extend_from_slice(shell_env);
    env.extend(tool_hist_env(g, id, shell));
    env.extend_from_slice(extra_env);
    env
}

/// 도구가 열릴 자리다. cwd 가 있는 디렉터리면 그것, 아니면 사용자 홈, 홈도 모르면 ".".
pub(crate) fn tool_start_dir(g: Getenv, cwd: &str) -> String {
    let mut dir = user_home(g);
    if !cwd.is_empty() && std::fs::metadata(cwd).is_ok_and(|m| m.is_dir()) {
        dir = cwd.to_string();
    }
    if dir.is_empty() {
        dir = ".".to_string();
    }
    dir
}

/// 도구 셸에 심을 히스토리 환경이다. 심을 수 없으면 비어 있다 (FR-THI-5).
pub(crate) fn tool_hist_env(g: Getenv, id: &str, shell_path: &str) -> Vec<String> {
    if !safe_hist_name(id) {
        return Vec::new();
    }
    let home = g(dmenv::ENV_HOME);
    if home.is_empty() {
        return Vec::new();
    }
    let shell = hist_shell_name(shell_path);
    if !safe_hist_name(&shell) {
        return Vec::new();
    }
    let dir = filepath::join(&[home.as_str(), TOOL_HIST_DIR]);
    if let Err(e) = mkdir_all_0700(Path::new(&dir)) {
        infof!(
            None,
            "[tool {id}] history dir: {}",
            dm_gocompat::oserr::path_error("mkdir", &dir, e)
        );
        return Vec::new();
    }
    let name = format!("{id}.{shell}");
    let path = filepath::join(&[dir.as_str(), name.as_str()]);
    seed_hist_file(Path::new(&path), user_hist_file(g, &shell).as_deref());
    vec![
        format!("HISTFILE={path}"),
        format!("{}={path}", dmenv::ENV_HIST_FILE),
    ]
}

fn mkdir_all_0700(dir: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(dir)
}

/// 그 셸이 평소 쓰는 히스토리 자리다 (FR-HPR-16). PowerShell 은 PSReadLine 의 고정 자리다.
pub(crate) fn user_hist_file(g: Getenv, shell: &str) -> Option<PathBuf> {
    if shell == "powershell" || shell == "pwsh" {
        let base = g("APPDATA");
        if base.is_empty() {
            return None;
        }
        return Some(PathBuf::from(filepath::join(&[
            base.as_str(),
            "Microsoft",
            "Windows",
            "PowerShell",
            "PSReadLine",
            "ConsoleHost_history.txt",
        ])));
    }
    let name = format!(".{shell}_history");
    Some(PathBuf::from(filepath::join(&[
        tool_home(g).as_str(),
        name.as_str(),
    ])))
}

/// 실행 경로에서 셸 이름을 뽑는다 — `/bin/zsh` → `zsh`, `powershell.exe` → `powershell`.
pub(crate) fn hist_shell_name(shell_path: &str) -> String {
    let base = filepath::base(shell_path);
    let ext = exe_suffix();
    let base = if ext.is_empty() {
        base.as_str()
    } else {
        base.strip_suffix(ext).unwrap_or(&base)
    };
    base.to_lowercase()
}

/// 파일 이름 한 조각으로 쓸 수 있는 값인지 본다. tools.json 은 사람이 고칠 수 있다.
pub(crate) fn safe_hist_name(s: &str) -> bool {
    !(s.is_empty() || s == "." || s == ".." || s.contains(['/', '\\', '\0']))
}

/// 도구의 히스토리 파일이 없을 때만 사용자 히스토리를 옮겨 놓는다 (FR-THI-10·13, D-6).
/// O_EXCL·0600 으로 만든다. 원본이 없어도 빈 파일을 만든다 (NFR-THI-1).
pub(crate) fn seed_hist_file(dst: &Path, src: Option<&Path>) {
    let mut o = OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    let Ok(mut f) = o.open(dst) else {
        return;
    };
    let Some(data) = src.and_then(|s| std::fs::read(s).ok()) else {
        return;
    };
    if let Err(e) = f.write_all(&data) {
        infof!(
            None,
            "history seed {}: {}",
            dst.display(),
            dm_gocompat::oserr::path_error("write", &dst.to_string_lossy(), e)
        );
    }
}

#[cfg(test)]
mod tests;
