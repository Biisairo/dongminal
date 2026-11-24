//! `otterminal verify` — **종단간** 검증이다 (E2E_UNIFICATION_SRS). 서버를 격리 인스턴스로 띄우고 그
//! 위의 HTTP 표면을 실제로 두드린다. doctor 는 서버 없이 플랫폼 계층을 보고, verify 는 프로세스
//! 경계를 넘은 뒤를 본다. 세 대상이 **같은 목록**을 돈다 — 대상별 갈래가 하나도 없다 (FR-E2S-0/2).

use std::io::Write;
use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use otter_gocompat::filepath;
use otter_gocompat::oserr::{go_error_string, path_error};
use otter_gocompat::strconv::quote;
use otter_shared_apipath as apipath;
use otter_shared_editorlimit::FILE_MAX_BYTES;
use otter_shared_otterenv as otterenv;
use otter_shared_platform::Process;
use otter_webserver_domain_git_core::{Ctx, Kind, Service};
use regex::Regex;

use crate::env::Env;
use crate::http::{self, block_on};
use crate::options::{StartOpts, VerifyOpts, expand_tilde};
use crate::proc::{daemon_pid, socket_exists, tail};
use crate::report::CheckReport;
use crate::shellwait::{ChangeTracker, QuietError, SHELL_QUIET_FOR, wait_quiet};
use crate::start::{
    ISOLATED_HOME_PREFIX, prepare_server_cmd, resolve_start_target, wait_ready_for,
};

const VERIFY_READY_TRIES: u32 = 40;
const VERIFY_READY_INTERVAL: Duration = Duration::from_millis(500);
const VERIFY_HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const VERIFY_COLS: u16 = 120;
const VERIFY_ROWS: u16 = 40;
/// 왕복 검사가 셸에 시키고 되받을 표시다. 현행 CI 와 같은 값을 승계한다 (D-5).
const VERIFY_MARKER: &str = "otterminal-e2e-ok";
/// 셸이 프롬프트를 그리기를 기다리는 상한이다 (판정은 `wait_quiet`).
const VERIFY_SHELL_WAIT: Duration = Duration::from_secs(20);
const VERIFY_POLL_EVERY: Duration = Duration::from_millis(100);
const VERIFY_ROUND_TRIP: Duration = Duration::from_secs(30);
/// 정중한 종료를 기다리는 시간이다.
const VERIFY_TERM_GRACE: Duration = Duration::from_secs(3);
const VERIFY_LOG_TAIL: usize = 40;
/// 능력 실측 하나의 상한이다.
const VERIFY_CAPS_TIMEOUT: Duration = Duration::from_secs(10);

// ── 격리 가드 ────────────────────────────────────────────────────────

/// 대상이 격리 인스턴스인지 판정한다 (FR-E2G-1). **순수 함수다** — 이 판정을 통과하기 전에 verify 는
/// 아무것도 띄우지 않고 아무것도 지우지 않는다 (FR-E2G-2). user_home 이 비면 그 조항만 건너뛴다.
pub(crate) fn guard_isolated(home: &str, port: &str, user_home: &str) -> Result<(), String> {
    if home.is_empty() {
        return Err("격리 홈이 비어 있습니다".to_owned());
    }
    if port.is_empty() {
        return Err("포트가 비어 있습니다".to_owned());
    }
    if !filepath::base(home).starts_with(ISOLATED_HOME_PREFIX) {
        return Err(format!("홈이 격리 홈이 아닙니다: {home}"));
    }
    if !user_home.is_empty()
        && filepath::clean(home) == filepath::join(&[user_home, otterenv::DEFAULT_HOME_DIR])
    {
        return Err(format!("홈이 사용자 기본 홈입니다: {home}"));
    }
    if port == otterenv::DEFAULT_PORT {
        return Err(format!(
            "포트가 기본 포트 {port} 입니다 — 운영 인스턴스일 수 있습니다"
        ));
    }
    Ok(())
}

// ── 능력 질의 ────────────────────────────────────────────────────────

/// **호스트 환경**이 무엇을 갖췄는지다. OS 의 능력이 아니다 (FR-E2S-3).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct VerifyCaps {
    /// git 이 PATH 에 있는지다.
    pub(crate) git_bin: bool,
    /// 검사 대상 디렉터리가 git 저장소인지다.
    pub(crate) git_repo: bool,
}

/// 호스트의 능력을 실측한다. git 을 직접 실행하지 않는다 — 저장소 판정은 git 도메인의 것을 딛는다
/// (FR-GIT-1, FR-E2K-4).
fn probe_caps(repo: &str) -> VerifyCaps {
    let ctx = Ctx::background().with_timeout(VERIFY_CAPS_TIMEOUT);
    match block_on(Service::new().repo_root(&ctx, repo)) {
        Ok(Ok(_)) => VerifyCaps {
            git_bin: true,
            git_repo: true,
        },
        Ok(Err(e)) if e.is(Kind::GitMissing) => VerifyCaps::default(),
        _ => VerifyCaps {
            git_bin: true,
            git_repo: false,
        },
    }
}

// ── 검사 정의 ────────────────────────────────────────────────────────

/// 검사가 딛는 상태다.
#[derive(Default)]
pub(crate) struct VerifySession {
    pub(crate) base: String,
    pub(crate) home: String,
    pub(crate) repo: String,
    pub(crate) pid: i32,
    pub(crate) caps: VerifyCaps,
    /// 검사 4가 채운다. 비어 있으면 뒤따르는 도구 검사가 선행 실패로 건너뛴다 (FR-E2K-6).
    pub(crate) tool_id: String,
}

type NeedFn = fn(&VerifySession) -> (bool, String);
type RunFn = Box<dyn Fn(&mut VerifySession) -> Result<String, String>>;

/// 검사 하나의 정의다. **데이터로 적는다** (NFR-E2E-4) — 목록을 셀 수 있어야 세 대상이 같은 목록을
/// 도는지 확인할 수 있다 (FR-E2I-6).
pub(crate) struct VerifyCheck {
    pub(crate) section: &'static str,
    pub(crate) name: String,
    /// 이 검사가 돌 수 있는 조건이다. 돌 수 없으면 이유를 내며 보고서에 남는다 (FR-E2S-4).
    pub(crate) need: Option<NeedFn>,
    /// 통과했을 때 덧붙일 상세를 함께 낸다. 비면 이름만 찍는다.
    pub(crate) run: RunFn,
}

pub(crate) fn need_tool(s: &VerifySession) -> (bool, String) {
    if s.tool_id.is_empty() {
        return (false, "도구 생성이 실패해 물을 것이 없다".to_owned());
    }
    (true, String::new())
}

pub(crate) fn need_git_repo(s: &VerifySession) -> (bool, String) {
    if !s.caps.git_bin {
        return (false, "git 이 PATH 에 없다".to_owned());
    }
    if !s.caps.git_repo {
        // 비-git 디렉터리는 정당하게 404 라서 라우팅 누락과 구별되지 않는다 (FR-E2K-4).
        return (false, format!("대상이 git 저장소가 아니다: {}", s.repo));
    }
    (true, String::new())
}

/// 경로를 두드려 기대 코드인지 본다.
fn want_status(want: u16, path: String) -> RunFn {
    Box::new(move |s| want_status_at(s, want, &path))
}

fn want_status_at(s: &VerifySession, want: u16, p: &str) -> Result<String, String> {
    let code = s.status(p).map_err(|e| format!("{p}: {e}"))?;
    if code != want {
        return Err(format!("want {want}, got {code} [{p}]"));
    }
    Ok(String::new())
}

fn check(section: &'static str, name: &str, need: Option<NeedFn>, run: RunFn) -> VerifyCheck {
    VerifyCheck {
        section,
        name: name.to_owned(),
        need,
        run,
    }
}

const S_BOOT: &str = "기동 표면";
const S_TOOL: &str = "도구 — PTY + IPC 왕복";
const S_WS: &str = "워크스페이스·설정";
const S_GIT: &str = "git 읽기 표면";
const S_STATIC: &str = "정적 자산";
const S_BOUND: &str = "경계";

/// 검사 전량이다 — 현행 세 하네스의 **합집합**이며 세 대상이 이 한 목록을 돈다 (FR-E2K-1).
pub(crate) fn verify_checks() -> Vec<VerifyCheck> {
    let mut checks = vec![
        check(
            S_BOOT,
            "서버 프로세스 생존",
            None,
            Box::new(|s| {
                if !otter_shared_platform::current().process.alive(s.pid) {
                    return Err(format!("pid {} 가 살아 있지 않다", s.pid));
                }
                Ok(String::new())
            }),
        ),
        check(
            S_BOOT,
            "데몬 종단 생성 (paned.sock)",
            None,
            Box::new(|s| {
                if !socket_exists(&s.home) {
                    return Err(format!("종단이 없다: {}", s.home));
                }
                Ok(String::new())
            }),
        ),
        check(
            S_BOOT,
            apipath::PING,
            None,
            want_status(200, apipath::PING.to_owned()),
        ),
        check(
            S_TOOL,
            "도구 생성",
            None,
            Box::new(VerifySession::create_tool),
        ),
        check(
            S_TOOL,
            "/api/state 에 도구가 보인다",
            Some(need_tool),
            Box::new(|s| s.tool_in_state()),
        ),
        check(
            S_TOOL,
            "busy 조회",
            Some(need_tool),
            Box::new(|s| {
                let p = format!("{}{}/busy", apipath::TOOLS_PREFIX, s.tool_id);
                want_status_at(s, 200, &p)
            }),
        ),
        check(
            S_TOOL,
            "도구 출력 조회",
            Some(need_tool),
            Box::new(|s| {
                let p = format!(
                    "{}?id={}&bytes=1024",
                    apipath::TOOLS_OUTPUT,
                    query_escape(&s.tool_id)
                );
                want_status_at(s, 200, &p)
            }),
        ),
        check(
            S_TOOL,
            "입력→출력 왕복",
            Some(need_tool),
            Box::new(|s| s.round_trip()),
        ),
        check(
            S_WS,
            apipath::WORKSPACE,
            None,
            want_status(200, apipath::WORKSPACE.to_owned()),
        ),
        check(
            S_WS,
            apipath::STATS,
            None,
            want_status(200, apipath::STATS.to_owned()),
        ),
        check(
            S_WS,
            apipath::SETTINGS,
            None,
            want_status(200, apipath::SETTINGS.to_owned()),
        ),
        // FR-FAB-14c: 제품의 UI 흐름처럼 대상을 먼저 등록한다.
        check(
            S_GIT,
            "검사 대상 저장소 등록",
            Some(need_git_repo),
            Box::new(|s| s.register_repo()),
        ),
    ];
    // repo 인자를 받는 것만 저장소를 요구한다 (FR-E2S-3).
    for e in ["status", "log", "refs", "signature", "stash", "records"] {
        checks.push(check(
            S_GIT,
            &format!("git {e}"),
            Some(need_git_repo),
            Box::new(move |s| {
                let p = format!("{}{e}?repo={}", apipath::GIT_PREFIX, query_escape(&s.repo));
                want_status_at(s, 200, &p)
            }),
        ));
    }
    checks.extend([
        check(
            S_GIT,
            "git policy",
            None,
            want_status(200, apipath::GIT_POLICY.to_owned()),
        ),
        check(
            S_GIT,
            "git jobs",
            None,
            want_status(200, apipath::GIT_JOBS.to_owned()),
        ),
        check(
            S_GIT,
            "없는 git 경로 404",
            None,
            want_status(404, format!("{}no-such-endpoint", apipath::GIT_PREFIX)),
        ),
        check(
            S_STATIC,
            "index.html 의 script 전량 200",
            None,
            Box::new(|s| s.static_assets()),
        ),
        check(
            S_STATIC,
            "구 평면 경로 /js/app.js 404",
            None,
            want_status(404, "/js/app.js".to_owned()),
        ),
        // ── 경계 (M2) ── 설치된 실물 서버에서 이 경계가 실제로 서 있는가를 묻는다.
        check(
            S_BOUND,
            "상대경로 400",
            None,
            want_status(400, format!("{}?path=relative.txt", apipath::FILE_READ)),
        ),
        check(
            S_BOUND,
            "읽기 상한 초과 413",
            None,
            Box::new(|s| s.file_over_limit_is_413()),
        ),
        check(
            S_BOUND,
            "정적 응답의 보안 헤더",
            None,
            Box::new(|s| s.static_security_headers()),
        ),
    ]);
    checks
}

// ── 검사 구현 ────────────────────────────────────────────────────────

impl VerifySession {
    fn get(&self, path: &str) -> Result<http::Reply, String> {
        http::get(&format!("{}{path}", self.base), VERIFY_HTTP_TIMEOUT)
    }

    fn post(&self, path: &str, body: &str) -> Result<http::Reply, String> {
        http::post_json(
            &format!("{}{path}", self.base),
            body.as_bytes().to_vec(),
            VERIFY_HTTP_TIMEOUT,
        )
    }

    fn status(&self, path: &str) -> Result<u16, String> {
        self.get(path).map(|r| r.status)
    }

    fn body(&self, path: &str) -> Result<String, String> {
        let r = self.get(path)?;
        if r.status != 200 {
            return Err(format!("want 200, got {} [{path}]", r.status));
        }
        Ok(String::from_utf8_lossy(&r.body).into_owned())
    }

    /// 도구를 만든다. cwd·cols·rows 는 쿼리 파라미터로 간다. 0 을 주면 Windows 의
    /// CreatePseudoConsole 이 E_INVALIDARG 로 실패한다.
    fn create_tool(&mut self) -> Result<String, String> {
        let q = format!(
            "{}?cwd={}&cols={VERIFY_COLS}&rows={VERIFY_ROWS}",
            apipath::TOOLS,
            query_escape(&self.repo)
        );
        let r = self.post(&q, "")?;
        let text = String::from_utf8_lossy(&r.body);
        if r.status != 200 {
            return Err(format!("want 200, got {} — {}", r.status, text.trim()));
        }
        let id = json_string_field(&text, "id");
        if id.is_empty() {
            return Err(format!("도구 id 를 받지 못했다 — {}", text.trim()));
        }
        self.tool_id.clone_from(&id);
        Ok(format!("id={id}"))
    }

    fn tool_in_state(&self) -> Result<String, String> {
        let body = self.body(apipath::STATE)?;
        if !body.contains(&self.tool_id) {
            return Err(format!("/api/state 에 {} 가 없다", self.tool_id));
        }
        Ok(String::new())
    }

    /// 셸에 명령을 넣고 그 출력에서 표시를 되받는다. 데몬 안의 의사 터미널이 실제로 입출력을
    /// 왕복해야만 통과한다 (CROSS_PLATFORM_SRS §11.6).
    fn round_trip(&self) -> Result<String, String> {
        self.wait_tool_quiet(VERIFY_SHELL_WAIT)?;
        let body = format!(
            r#"{{"id":{},"text":{},"execute":true}}"#,
            json_quote(&self.tool_id),
            json_quote(&format!("echo {VERIFY_MARKER}"))
        );
        let r = self.post(apipath::TOOLS_INPUT, &body)?;
        if r.status != 200 {
            return Err(format!("입력 전송 실패: {}", r.status));
        }

        let deadline = Instant::now() + VERIFY_ROUND_TRIP;
        let mut seen = String::new();
        while Instant::now() < deadline {
            std::thread::sleep(VERIFY_POLL_EVERY);
            let Ok(out) = self.tool_output() else {
                continue;
            };
            seen = out;
            // 표시를 두 번 본다 — 타이핑된 명령 자체와 셸이 실행해 낸 출력이다.
            if seen.matches(VERIFY_MARKER).count() >= 2 {
                return Ok(format!("{}바이트", seen.len()));
            }
        }
        // 0 이면 셸이 명령을 받지 못했고, 1 이면 에코만 보이고 실행 결과가 없다 — 원인이 다르다.
        Err(format!(
            "출력에서 {VERIFY_MARKER} 를 {}번 보았다 (2번이어야 한다: 에코 + 실행 결과, 받은 {}바이트)",
            seen.matches(VERIFY_MARKER).count(),
            seen.len()
        ))
    }

    fn tool_output(&self) -> Result<String, String> {
        self.body(&format!(
            "{}?id={}&strip=1",
            apipath::TOOLS_OUTPUT,
            query_escape(&self.tool_id)
        ))
    }

    /// 셸이 무언가를 그리고 조용해질 때까지 기다린다. 조회 실패는 변화 없음으로 본다. 계속 변하고
    /// 있으면 그린 것은 있으므로 진행한다.
    fn wait_tool_quiet(&self, limit: Duration) -> Result<(), String> {
        let mut c = ChangeTracker::default();
        let mut last = (0, None);
        let res = wait_quiet(
            || {
                if let Ok(out) = self.tool_output() {
                    last = c.observe(out.as_bytes());
                }
                Ok::<_, String>(last)
            },
            limit,
            SHELL_QUIET_FOR,
        );
        match res {
            Ok(()) | Err(QuietError::NotQuiet) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// index.html 이 **실제로 참조하는** script 전량을 두드린다. 목록을 손으로 적지 않는다 (FR-E2K-3).
    fn static_assets(&self) -> Result<String, String> {
        let index = self.body("/")?;
        let srcs = extract_script_srcs(&index);
        if srcs.is_empty() {
            return Err("index.html 에서 script src 를 하나도 찾지 못했다".to_owned());
        }
        let mut bad = Vec::new();
        for src in &srcs {
            match self.status(&format!("/{}", src.trim_start_matches('/'))) {
                Err(e) => bad.push(format!("{src} ({e})")),
                Ok(200) => {}
                Ok(code) => bad.push(format!("{src} → {code}")),
            }
        }
        if !bad.is_empty() {
            return Err(format!(
                "{}/{} 실패: {}",
                bad.len(),
                srcs.len(),
                bad.join(", ")
            ));
        }
        Ok(format!("{}개", srcs.len()))
    }

    /// 검사 대상 저장소를 워크스페이스에 등록한다 (FR-FAB-14c). 검사가 제품의 흐름을 흉내낸다.
    fn register_repo(&self) -> Result<String, String> {
        let r = self.post(
            apipath::EDITORS_ADD,
            &format!(r#"{{"path":{}}}"#, quote(&self.repo)),
        )?;
        if r.status != 200 {
            return Err(format!("editors/add → {}", r.status));
        }
        Ok(self.repo.clone())
    }

    /// 상한 초과는 **실제 파일**로 확인한다. 크기만 잡아 디스크를 쓰지 않는다.
    fn file_over_limit_is_413(&self) -> Result<String, String> {
        let over = FILE_MAX_BYTES + 1;
        let p = filepath::join(&[self.home.as_str(), "verify-too-large.bin"]);
        let f = std::fs::File::create(&p).map_err(|e| {
            format!(
                "큰 파일을 만들지 못했다: {}",
                go_error_string(&path_error("open", &p, e))
            )
        })?;
        let sized = f.set_len(u64::try_from(over).unwrap_or(u64::MAX));
        drop(f);
        struct Remove<'a>(&'a str);
        impl Drop for Remove<'_> {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(self.0);
            }
        }
        let _rm = Remove(&p);
        sized.map_err(|e| {
            format!(
                "크기를 잡지 못했다: {}",
                go_error_string(&path_error("truncate", &p, e))
            )
        })?;

        let code = self.status(&format!("{}?path={}", apipath::FILE_READ, query_escape(&p)))?;
        if code != 413 {
            return Err(format!("{over}바이트 읽기 → {code}, want 413"));
        }
        Ok(format!("{}MiB 초과 → 413", FILE_MAX_BYTES >> 20))
    }

    fn static_security_headers(&self) -> Result<String, String> {
        let r = self.get("/")?;
        for h in [
            "Content-Security-Policy",
            "X-Frame-Options",
            "X-Content-Type-Options",
        ] {
            if r.headers.get(h).is_none_or(|v| v.is_empty()) {
                return Err(format!("{h} 가 없다"));
            }
        }
        Ok("CSP · X-Frame-Options · nosniff".to_owned())
    }
}

static SCRIPT_SRC_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<script[^>]*\bsrc="([^"]+)""#).unwrap_or_else(|e| unreachable!("{e}"))
});

/// HTML 에서 script 의 src 를 뽑는다. 외부 주소와 중복은 뺀다.
pub(crate) fn extract_script_srcs(html: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in SCRIPT_SRC_RE.captures_iter(html) {
        let src = &m[1];
        if src.is_empty() || src.contains("://") || out.iter().any(|s| s == src) {
            continue;
        }
        out.push(src.to_owned());
    }
    out
}

/// 값을 JSON 문자열 리터럴로 만든다 — 바깥 따옴표를 포함한다. Windows 경로를 날것으로 끼우면 `\U` 가
/// 유효하지 않은 이스케이프가 되어 본문이 통째로 깨진다.
pub(crate) fn json_quote(s: &str) -> String {
    let mut b = String::with_capacity(s.len() + 2);
    b.push('"');
    for r in s.chars() {
        match r {
            '"' => b.push_str("\\\""),
            '\\' => b.push_str("\\\\"),
            '\n' => b.push_str("\\n"),
            '\r' => b.push_str("\\r"),
            '\t' => b.push_str("\\t"),
            _ => b.push(r),
        }
    }
    b.push('"');
    b
}

static JSON_FIELD_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#""([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)""#).unwrap_or_else(|e| unreachable!("{e}"))
});

/// 평평한 JSON 에서 문자열 필드를 꺼낸다. 응답에서 id 하나를 얻으려고 모델을 만들지 않는다.
pub(crate) fn json_string_field(blob: &str, field: &str) -> String {
    JSON_FIELD_RE
        .captures_iter(blob)
        .find(|m| &m[1] == field)
        .map(|m| m[2].to_owned())
        .unwrap_or_default()
}

/// Go `url.QueryEscape` — 영숫자와 `-_.~` 만 두고, 공백은 `+`, 나머지는 `%XX` 다.
pub(crate) fn query_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(char::from(b));
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ── 실행 ─────────────────────────────────────────────────────────────

pub fn run_verify(o: &VerifyOpts, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    run_verify_in(o, &Env::process(), stdout, stderr)
}

/// 순서가 안전의 일부다: **대상을 정하고 → 가드를 통과한 뒤에야** 무언가를 띄운다 (FR-E2G-2).
pub(crate) fn run_verify_in(
    o: &VerifyOpts,
    env: &Env<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let repo = match verify_repo(&o.repo, env) {
        Ok(r) => r,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    // 환경변수를 보지 않는다 — 검사는 격리 홈·빈 포트에서 돈다 (FR-E2C-4).
    let iso = StartOpts {
        isolated: true,
        ..StartOpts::default()
    };
    let (home, port) = match resolve_start_target(&iso, env) {
        Ok(t) => t,
        Err(e) => {
            let _ = writeln!(stderr, "격리 대상 준비 실패: {e}");
            return 1;
        }
    };
    let user_home = env.user_home_dir().unwrap_or_default();
    if let Err(e) = guard_isolated(&home, &port, &user_home) {
        // 운영 인스턴스를 건드리느니 검증을 못 하는 편이 낫다.
        let _ = writeln!(stderr, "❌ 격리 가드: {e}");
        return 1;
    }

    let mut r = CheckReport::new(stdout);
    let _ = writeln!(
        r.out(),
        "otterminal verify — platform={}",
        otter_shared_platform::current().os
    );
    r.section("격리 인스턴스 기동");
    let host = otterenv::DEFAULT_HOST;
    // 자식은 바인드를 격리 홈의 `server.json` 에서 읽는다 (FR-HRB-4·5).
    if let Err(e) = otter_shared_serverconf::set_bind(Path::new(&home), host, &port) {
        let _ = writeln!(stderr, "{e}");
        return 1;
    }
    // 서버 로그도 격리 홈 안에 둔다.
    let log = filepath::join(&[home.as_str(), otterenv::SERVER_LOG_FILE]);
    let mut sc = match prepare_server_cmd(&home, &log, env) {
        Ok(c) => c,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    let child = match sc.cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = writeln!(stderr, "기동 실패: {}", go_error_string(&e));
            return 1;
        }
    };
    let mut s = VerifySession {
        base: otterenv::base_url(host, &port),
        home: home.clone(),
        caps: probe_caps(&repo),
        repo,
        pid: i32::try_from(child.id()).unwrap_or(0),
        tool_id: String::new(),
    };
    // 무엇을 겨눴는지 로그만 보고 알 수 있어야 한다 (FR-E2R-6).
    r.info(format!(
        "대상 url={} home={} pid={} repo={}",
        s.base, s.home, s.pid, s.repo
    ));

    let code = if wait_ready_for(&s.base, VERIFY_READY_TRIES, VERIFY_READY_INTERVAL) {
        r.ok("서버 준비됨");
        let pass = run_verify_checks(&mut r, &mut s);
        verify_summary(&mut r, pass, &home, &sc.log_path)
    } else {
        r.bad(format!("서버가 뜨지 않았다 — {}", s.base));
        verify_summary(&mut r, 0, &home, &sc.log_path)
    };
    cleanup_verify(&home, &port, s.pid, &user_home, &mut r);
    drop(child);
    code
}

/// 검사 표를 순서대로 돈다. 건너뜀의 근거는 언제나 호스트 능력이나 선행 검사의 결과다.
pub(crate) fn run_verify_checks(r: &mut CheckReport<'_>, s: &mut VerifySession) -> usize {
    let mut pass = 0;
    let mut section = "";
    for c in verify_checks() {
        if c.section != section {
            section = c.section;
            r.section(section);
        }
        if let Some(need) = c.need {
            let (ok, why) = need(s);
            if !ok {
                r.skipped(&c.name, &why);
                continue;
            }
        }
        match (c.run)(s) {
            Err(e) => r.bad(format!("{} — {e}", c.name)),
            Ok(d) if d.is_empty() => {
                r.ok(&c.name);
                pass += 1;
            }
            Ok(d) => {
                r.ok(format!("{} — {d}", c.name));
                pass += 1;
            }
        }
    }
    pass
}

/// 요약을 찍고 종료 코드를 낸다. **건너뜀은 실패가 아니다** (FR-E2C-6).
pub(crate) fn verify_summary(
    r: &mut CheckReport<'_>,
    pass: usize,
    home: &str,
    server_log: &str,
) -> i32 {
    let (fail, skip) = (r.fail, r.skip);
    let bads = r.bads.clone();
    let out = r.out();
    let _ = writeln!(out, "\n────────────────────────────────────────");
    let _ = writeln!(out, "통과 {pass}건 / 실패 {fail}건 / 건너뜀 {skip}건");
    if fail == 0 {
        return 0;
    }
    // 꼬리만 붙여도 답이 실리도록 실패를 다시 모아 찍는다 (FR-E2R-3).
    let _ = writeln!(out, "실패 항목:");
    for b in &bads {
        let _ = writeln!(out, "  ❌ {b}");
    }
    let daemon_log = filepath::join(&[home, otterenv::DAEMON_LOG_FILE]);
    for (name, path) in [
        ("데몬 로그", daemon_log.as_str()),
        ("서버 로그", server_log),
    ] {
        let t = tail(path, VERIFY_LOG_TAIL);
        if !t.is_empty() {
            let _ = writeln!(out, "\n[{name}] {path}\n{t}");
        }
    }
    1
}

/// **우리가 띄운 것만** 치운다 (FR-E2G-3). 포트로 대상을 찾는 stop 은 쓰지 않는다 — 기본 포트의
/// 운영 인스턴스를 죽일 갈래가 생긴다 (FR-E2G-4).
fn cleanup_verify(
    home: &str,
    port: &str,
    server_pid: i32,
    user_home: &str,
    r: &mut CheckReport<'_>,
) {
    let proc = otter_shared_platform::current().process;
    stop_verify_pid(proc, server_pid);
    let (dpid, alive) = daemon_pid(home, proc);
    if alive {
        stop_verify_pid(proc, dpid);
    }
    // 지우기 **직전에** 이름 조건을 다시 확인한다 (FR-E2G-6).
    if let Err(e) = guard_isolated(home, port, user_home) {
        r.info(format!("격리 홈을 지우지 않았다 — {e}"));
        return;
    }
    if let Err(e) = std::fs::remove_dir_all(home) {
        // Windows 에서 핸들이 남아 실패할 수 있다. 검사 실패로 치지 않는다.
        r.info(format!(
            "격리 홈 삭제 실패 (무시): {}",
            go_error_string(&path_error("unlinkat", home, e))
        ));
    }
}

/// 정중히 요청하고, 유예 뒤에도 남아 있으면 끝낸다 (FR-E2G-5).
fn stop_verify_pid(p: &dyn Process, pid: i32) {
    if pid <= 0 || !p.alive(pid) {
        return;
    }
    let _ = p.terminate(pid);
    let deadline = Instant::now() + VERIFY_TERM_GRACE;
    while Instant::now() < deadline {
        if !p.alive(pid) {
            return;
        }
        std::thread::sleep(VERIFY_POLL_EVERY);
    }
    let _ = p.kill(pid);
}

/// git 표면 검사의 대상을 절대경로로 정한다.
fn verify_repo(arg: &str, env: &Env<'_>) -> Result<String, String> {
    if arg.is_empty() {
        return std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .map_err(|e| {
                format!(
                    "현재 디렉터리 확인 실패: {}",
                    go_error_string(&path_error("getwd", ".", e))
                )
            });
    }
    filepath::abs(&expand_tilde(arg, env))
        .map_err(|e| format!("--repo 경로 확인 실패: {}", go_error_string(&e)))
}
