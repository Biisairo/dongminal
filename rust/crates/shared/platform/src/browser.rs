//! 브라우저 명령 조립 (FR-XBR-1, FR-VUO-2). 실행은 호출자가 한다.
//!
//! launcher 는 자기가 이 환경에서 쓸 수 있는지를 스스로 판정하고, 체인은 순서대로 물어 먼저
//! 답하는 것을 쓴다. 그래서 "여기가 WSL 인가" 를 묻는 코드가 없다 (FR-XPL-3, FR-XWS-2).
//! 세 체인 모두 cfg 없이 컴파일되어 어느 호스트에서도 검사된다.

use std::io;
use std::sync::LazyLock;

use crate::shell::gopath::Conv;
use crate::shell::{EnvFn, LookFn, StatFn, power_shell_quote};

/// frameless window(주소창 없는 앱 창)를 여는 명령 `(name, args)`.
pub trait Browser: Send + Sync {
    fn frameless_command(&self, url: &str) -> io::Result<(String, Vec<String>)>;
}

/// URL 을 평범한 브라우저 창/탭으로 여는 명령 `(name, args)`.
pub trait Opener: Send + Sync {
    fn open_command(&self, url: &str) -> io::Result<(String, Vec<String>)>;
}

type ArgsFn = fn(&str) -> Vec<String>;

enum Launcher {
    /// PATH 에서 이름들을 차례로 찾아 먼저 있는 것을 쓴다.
    Path(&'static [&'static str], ArgsFn),
    /// PATH 밖의 표준 설치 자리 `(환경변수, 상대경로)` 를 훑는다.
    Install(&'static [(&'static str, &'static str)], ArgsFn),
    /// 조건 없이 답한다. 그 플랫폼에 반드시 있는 명령만, 체인의 마지막에 둔다.
    Fixed(&'static str, ArgsFn),
}

/// launcher 체인. Browser 와 Opener 가 해소 규칙(resolve)을 공유한다.
pub(crate) struct Chain {
    look: LookFn,
    env: EnvFn,
    stat: StatFn,
    chain: Vec<Launcher>,
    /// 아무도 답하지 못했을 때의 안내.
    hint: &'static str,
}

impl Chain {
    fn command(&self, l: &Launcher, url: &str) -> Option<(String, Vec<String>)> {
        match l {
            Launcher::Path(names, args) => names
                .iter()
                .find_map(|n| (self.look)(n))
                .map(|p| (p, args(url))),
            Launcher::Install(cands, args) => cands.iter().find_map(|(env, rel)| {
                let base = (self.env)(env);
                // 빈 환경변수를 Join 하면 상대경로가 되어 엉뚱한 파일을 가리킨다.
                if base.is_empty() {
                    return None;
                }
                let path = Conv::HOST.join(&[&base, rel]);
                (self.stat)(&path).then(|| (path, args(url)))
            }),
            Launcher::Fixed(name, args) => Some(((*name).to_owned(), args(url))),
        }
    }

    fn resolve(&self, url: &str) -> io::Result<(String, Vec<String>)> {
        self.chain
            .iter()
            .find_map(|l| self.command(l, url))
            .ok_or_else(|| io::Error::other(self.hint))
    }
}

impl Browser for Chain {
    fn frameless_command(&self, url: &str) -> io::Result<(String, Vec<String>)> {
        self.resolve(url)
    }
}

impl Opener for Chain {
    fn open_command(&self, url: &str) -> io::Result<(String, Vec<String>)> {
        self.resolve(url)
    }
}

// ── 인자 ─────────────────────────────────────────────

const MAC_OPEN: &str = "open";
const MAC_BROWSER_APP: &str = "Google Chrome";
const WIN_RUNDLL: &str = "rundll32";
const WIN_URL_HANDLER: &str = "url.dll,FileProtocolHandler";

/// 크로미움 계열에 frameless window 를 요구한다.
fn app_args(url: &str) -> Vec<String> {
    vec![format!("--app={url}")]
}

fn plain_args(url: &str) -> Vec<String> {
    vec![url.to_owned()]
}

/// url 은 축자 문자열로 넘긴다. Go 는 `Start-Process <url>` 을 따로 넘겨 PowerShell 이 url 을
/// 스크립트로 읽었다 — `;`·`$( )` 로 명령 주입이 됐다 (RUST_PORT_SRS 3.7 D-2).
fn start_process_args(url: &str) -> Vec<String> {
    vec![
        "-NoProfile".to_owned(),
        "-Command".to_owned(),
        format!("Start-Process -FilePath {}", power_shell_quote(url)),
    ]
}

/// macOS `open` 으로 앱 번들을 이름으로 연다.
fn mac_app_args(url: &str) -> Vec<String> {
    vec![
        "-na".to_owned(),
        MAC_BROWSER_APP.to_owned(),
        "--args".to_owned(),
        format!("--app={url}"),
    ]
}

fn win_handler_args(url: &str) -> Vec<String> {
    vec![WIN_URL_HANDLER.to_owned(), url.to_owned()]
}

// ── 체인 구성 요소 ───────────────────────────────────

/// 리눅스의 크로미움 계열. 종전 scripts/open_frameless_window.sh 와 순서가 같다.
const CHROMIUM_NAMES: &[&str] = &[
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
];
const WIN_CHROMIUM_NAMES: &[&str] = &["chrome.exe", "msedge.exe"];
const CHROME_REL_PATH: &str = r"Google\Chrome\Application\chrome.exe";
const EDGE_REL_PATH: &str = r"Microsoft\Edge\Application\msedge.exe";
const WIN_INSTALL_CANDIDATES: &[(&str, &str)] = &[
    ("ProgramFiles", CHROME_REL_PATH),
    ("ProgramFiles(x86)", CHROME_REL_PATH),
    ("LOCALAPPDATA", CHROME_REL_PATH),
    ("ProgramFiles(x86)", EDGE_REL_PATH),
    ("ProgramFiles", EDGE_REL_PATH),
];
const XDG_OPEN: &[&str] = &["xdg-open"];
const WSLVIEW: &[&str] = &["wslview"];
const HOST_POWERSHELL: &[&str] = &["powershell.exe"];

const UNIX_BROWSER_HINT: &str = "브라우저를 열 수단을 찾지 못했습니다. Chrome 또는 Chromium 을 설치하세요 \
(WSL 이라면 wslu 설치로 호스트 브라우저를 쓸 수 있습니다)";
const UNIX_OPENER_HINT: &str = "URL 을 열 수단을 찾지 못했습니다. xdg-utils 를 설치하세요 \
(WSL 이라면 wslu 로 호스트 브라우저를 쓸 수 있습니다)";

/// 리눅스에서 호스트 Windows 로 URL 을 넘기는 수단. WSL 밖에서는 PATH 에 없어 스스로 빠진다.
/// 이 경로로 열면 frameless window 는 포기한다.
fn host_openers() -> [Launcher; 2] {
    [
        Launcher::Path(WSLVIEW, plain_args),
        Launcher::Path(HOST_POWERSHELL, start_process_args),
    ]
}

fn no_look() -> LookFn {
    Box::new(|_| None)
}

fn no_env() -> EnvFn {
    Box::new(|_| String::new())
}

fn no_stat() -> StatFn {
    Box::new(|_| false)
}

fn fixed_chain(l: Launcher) -> Chain {
    Chain {
        look: no_look(),
        env: no_env(),
        stat: no_stat(),
        chain: vec![l],
        hint: "",
    }
}

// ── 체인 조립 ────────────────────────────────────────

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn mac_browser() -> Chain {
    fixed_chain(Launcher::Fixed(MAC_OPEN, mac_app_args))
}

#[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
pub(crate) fn unix_browser(look: LookFn) -> Chain {
    let mut chain = vec![Launcher::Path(CHROMIUM_NAMES, app_args)];
    chain.extend(host_openers());
    Chain {
        look,
        env: no_env(),
        stat: no_stat(),
        chain,
        hint: UNIX_BROWSER_HINT,
    }
}

/// 마지막이 기본 브라우저 위임이므로 실패하지 않는다.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn win_browser(look: LookFn, env: EnvFn, stat: StatFn) -> Chain {
    Chain {
        look,
        env,
        stat,
        chain: vec![
            Launcher::Path(WIN_CHROMIUM_NAMES, app_args),
            Launcher::Install(WIN_INSTALL_CANDIDATES, app_args),
            Launcher::Fixed(WIN_RUNDLL, win_handler_args),
        ],
        hint: "",
    }
}

/// 인자 없는 `open` 은 기본 브라우저를 쓴다.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn mac_opener() -> Chain {
    fixed_chain(Launcher::Fixed(MAC_OPEN, plain_args))
}

#[cfg_attr(any(target_os = "macos", windows), allow(dead_code))]
pub(crate) fn unix_opener(look: LookFn) -> Chain {
    let mut chain = vec![Launcher::Path(XDG_OPEN, plain_args)];
    chain.extend(host_openers());
    Chain {
        look,
        env: no_env(),
        stat: no_stat(),
        chain,
        hint: UNIX_OPENER_HINT,
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn win_opener() -> Chain {
    fixed_chain(Launcher::Fixed(WIN_RUNDLL, win_handler_args))
}

#[cfg(target_os = "macos")]
fn system_chains() -> (Chain, Chain) {
    (mac_browser(), mac_opener())
}

#[cfg(windows)]
fn system_chains() -> (Chain, Chain) {
    (
        win_browser(
            Box::new(crate::shell::lookpath::look_path),
            Box::new(crate::shell::os_env),
            Box::new(crate::shell::stat_exists),
        ),
        win_opener(),
    )
}

#[cfg(not(any(target_os = "macos", windows)))]
fn system_chains() -> (Chain, Chain) {
    (
        unix_browser(Box::new(crate::shell::lookpath::look_path)),
        unix_opener(Box::new(crate::shell::lookpath::look_path)),
    )
}

static CHAINS: LazyLock<(Chain, Chain)> = LazyLock::new(system_chains);

pub(crate) fn current_browser() -> &'static dyn Browser {
    &CHAINS.0
}

pub(crate) fn current_opener() -> &'static dyn Opener {
    &CHAINS.1
}

#[cfg(test)]
mod tests;
