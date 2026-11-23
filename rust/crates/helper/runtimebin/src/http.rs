//! 서버 주소, HTTP 왕복, 응답 → 종료 코드 (REFACTOR3_DEDUP_GO_SRS FR-RDG-20·21).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use dm_gocompat::json::{self, RawMessage};
use dm_gocompat::neturl_err::{self, UrlError};
use dm_shared_dmenv as dmenv;
use dm_shared_serverconf as serverconf;
use serde::Deserialize;
use serde_json::Value;

use crate::budgets::HTTP_DEFAULT_BUDGET;
use crate::ctx::{Ctx, Env, errf};

/// HTTP 한 번의 결과. Go `(status, body, err)` 와 같다 — 본문을 읽다 실패하면 셋이 모두 찬다.
pub(crate) struct HttpOut {
    pub status: u16,
    pub body: Vec<u8>,
    pub err: Option<String>,
    /// Go `net.Error.Timeout()` — 예산 안에 끝나지 않았다.
    pub timeout: bool,
}

impl HttpOut {
    pub fn ok(status: u16, body: &[u8]) -> Self {
        Self {
            status,
            body: body.to_vec(),
            err: None,
            timeout: false,
        }
    }
    fn failed(err: String) -> Self {
        Self {
            status: 0,
            body: Vec::new(),
            err: Some(err),
            timeout: false,
        }
    }
}

/// 이 셸이 붙을 서버 주소다 (HOT_REBIND_SRS FR-HRB-12·13·14). 주소 파일 → `server.json` →
/// 기본값 순서이고 요청마다 다시 읽는다. 샌드박스 컨테이너 안은 마운트된 주소 파일, 없으면
/// 기동 때 심은 `DONGMINAL_PORT` 다.
pub(crate) fn server_addr(env: &Env) -> (String, String) {
    if env.get(dmenv::ENV_HOST) == dmenv::CONTAINER_HOST {
        if let Some((_, p)) = serverconf::read_addr_file(&container_addr_file(env)) {
            return (dmenv::CONTAINER_HOST.to_owned(), p);
        }
        let port = env.get(dmenv::ENV_PORT);
        let port = if port.is_empty() {
            dmenv::DEFAULT_PORT.to_owned()
        } else {
            port
        };
        return (dmenv::CONTAINER_HOST.to_owned(), port);
    }
    let home = helper_home(env);
    let home = Path::new(&home);
    if let Some(hp) = serverconf::read_addr(home) {
        return hp;
    }
    let getenv = |k: &str| env.get(k);
    let conf = serverconf::resolve(&serverconf::Inputs {
        home,
        getenv: Some(&getenv),
        ..Default::default()
    });
    (conf.host.value, conf.port.value)
}

fn container_addr_file(env: &Env) -> PathBuf {
    env.container_addr_file.clone().unwrap_or_else(|| {
        PathBuf::from(dm_gocompat::path::join(&[
            dmenv::CONTAINER_ADDR_DIR,
            serverconf::ADDR_FILE_NAME,
        ]))
    })
}

/// 인스턴스 홈이다. 서버가 셸에 `DONGMINAL_HOME` 을 넣는다. 없으면 기본 홈이다.
pub(crate) fn helper_home(env: &Env) -> String {
    let h = env.get(dmenv::ENV_HOME);
    if !h.is_empty() {
        return h;
    }
    if let Some(fb) = &env.fallback_home {
        return fb.to_string_lossy().into_owned();
    }
    let user = user_home_dir(env);
    if user.is_empty() {
        return String::new();
    }
    dm_gocompat::filepath::join(&[user.as_str(), dmenv::DEFAULT_HOME_DIR])
}

/// Go `os.UserHomeDir` — 비어 있으면 실패다.
fn user_home_dir(env: &Env) -> String {
    if cfg!(windows) {
        env.get("USERPROFILE")
    } else {
        env.get("HOME")
    }
}

pub(crate) fn base_url(env: &Env) -> String {
    let (h, p) = server_addr(env);
    dmenv::base_url(&h, &p)
}

pub(crate) fn current_port(env: &Env) -> String {
    server_addr(env).1
}

/// 이 셸이 속한 도구다. runtimebin 안에서 도구 식별자를 읽는 유일한 자리다.
pub(crate) fn self_tool_id(env: &Env) -> String {
    env.get(dmenv::ENV_TOOL_ID)
}

/// 요청 하나. budget 이 0 이면 공용 예산(10초)이다.
pub(crate) fn http_do(
    method: &str,
    url: &str,
    body: Option<Vec<u8>>,
    json_ct: bool,
    budget: Duration,
) -> HttpOut {
    let budget = if budget.is_zero() {
        HTTP_DEFAULT_BUDGET
    } else {
        budget
    };
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => return HttpOut::failed(UrlError::new(method, url, e.to_string()).to_string()),
    };
    rt.block_on(send(method, url, body, json_ct, budget))
}

async fn send(
    method: &str,
    url: &str,
    body: Option<Vec<u8>>,
    json_ct: bool,
    budget: Duration,
) -> HttpOut {
    // reqwest 의 rustls-no-provider 는 프로세스 공통 암호 공급자를 요구한다. 이미 있으면 그대로 쓴다.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let failed = |e: reqwest::Error| HttpOut {
        timeout: e.is_timeout(),
        ..HttpOut::failed(UrlError::from_reqwest(method, url, &e).to_string())
    };
    let client = match reqwest::Client::builder()
        .timeout(budget)
        .redirect(neturl_err::redirect_policy())
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(e) => return failed(e),
    };
    let m = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let mut req = client.request(m, url);
    if json_ct {
        req = req.header(reqwest::header::CONTENT_TYPE, "application/json");
    }
    if let Some(b) = body {
        req = req.body(b);
    }
    let mut res = match req.send().await {
        Ok(r) => r,
        Err(e) => return failed(e),
    };
    let status = res.status().as_u16();
    let mut data = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(c)) => data.extend_from_slice(&c),
            Ok(None) => break,
            Err(e) => {
                return HttpOut {
                    status,
                    body: data,
                    err: Some(neturl_err::body_error(&e)),
                    timeout: e.is_timeout(),
                };
            }
        }
    }
    HttpOut::ok(status, &data)
}

/// JSON 본문을 싣는 요청이다.
pub(crate) fn http_json_within(method: &str, url: &str, body: &Value, budget: Duration) -> HttpOut {
    match json::marshal(body) {
        Ok(buf) => http_do(method, url, Some(buf), true, budget),
        Err(e) => HttpOut::failed(e.to_string()),
    }
}

pub(crate) fn http_post_json_within(url: &str, body: &Value, budget: Duration) -> HttpOut {
    http_json_within("POST", url, body, budget)
}

pub(crate) fn http_post_json(url: &str, body: &Value) -> HttpOut {
    http_post_json_within(url, body, Duration::ZERO)
}

pub(crate) fn http_get_within(url: &str, budget: Duration) -> HttpOut {
    http_do("GET", url, None, false, budget)
}

pub(crate) fn http_get(url: &str) -> HttpOut {
    http_get_within(url, Duration::ZERO)
}

/// 서버의 요청 게이트는 상태를 바꾸는 메서드에 JSON Content-Type 을 요구한다 — DELETE 도 그렇다.
#[allow(dead_code)]
pub(crate) fn http_delete(url: &str) -> HttpOut {
    http_do("DELETE", url, None, true, Duration::ZERO)
}

// ── 응답 → 종료 코드 ──────────────────────────────────

pub(crate) type OnErr<'r> = Box<dyn FnMut(&mut Ctx<'_>, &str) -> i32 + 'r>;
type Accept = fn(u16) -> bool;
type Refuse<'r> = Box<dyn FnMut(&mut Ctx<'_>, u16, &[u8]) -> i32 + 'r>;

/// 한 종단의 응답 해석이다.
pub(crate) struct ExitRule<'r> {
    /// 연결 실패 줄의 머리다: "<prefix>: <err>" 를 쓰고 1.
    pub prefix: &'r str,
    /// 있으면 prefix 대신 이것이 연결 실패를 답한다.
    pub on_err: Option<OnErr<'r>>,
    /// `None` 이면 2xx 가 성공이다.
    pub ok: Option<Accept>,
    /// 성공이 아닌 상태를 답한다. 돌려준 값이 종료 코드다.
    pub refuse: Refuse<'r>,
}

/// HTTP 결과 하나를 종료 코드로 옮긴다. `Ok(본문)` 일 때만 호출자가 이어 읽는다.
pub(crate) fn http_exit(
    ctx: &mut Ctx<'_>,
    r: HttpOut,
    mut rule: ExitRule<'_>,
) -> Result<Vec<u8>, i32> {
    if let Some(e) = r.err {
        if let Some(on_err) = rule.on_err.as_mut() {
            return Err(on_err(ctx, &e));
        }
        errf!(ctx, "{}: {}\n", rule.prefix, e);
        return Err(1);
    }
    let accept = rule.ok.unwrap_or(is_2xx);
    if !accept(r.status) {
        return Err((rule.refuse)(ctx, r.status, &r.body));
    }
    Ok(r.body)
}

pub(crate) fn is_2xx(status: u16) -> bool {
    (200..300).contains(&status)
}

/// `/api/commands` 계열의 성공 판정이다 — 400 미만을 성공으로 읽는다.
pub(crate) fn below_400(status: u16) -> bool {
    status < 400
}

/// 거절을 찍고 1 로 끝나는 refuse 다.
pub(crate) fn refuse_with<'r>(render: impl Fn(&mut dyn Write, u16, &[u8]) + 'r) -> Refuse<'r> {
    Box::new(move |ctx: &mut Ctx<'_>, st, b| {
        render(ctx.err, st, b);
        1
    })
}

/// `{error}` 방언의 종단이다 (FR-OPT-9-2).
pub(crate) fn api_rule(path: &str) -> ExitRule<'_> {
    ExitRule {
        prefix: "dmctl",
        on_err: None,
        ok: None,
        refuse: refuse_with(move |w, st, b| print_api_error(w, st, path, b)),
    }
}

/// `{code,message}` 방언의 종단이다 (edge·account, FR-PNW-74).
#[allow(dead_code)]
pub(crate) fn code_rule() -> ExitRule<'static> {
    ExitRule {
        prefix: "dmctl",
        on_err: None,
        ok: None,
        refuse: refuse_with(print_code_refusal),
    }
}

/// apiRule 로 결과 하나를 옮긴다.
pub(crate) fn api_result(ctx: &mut Ctx<'_>, path: &str, r: HttpOut) -> Result<Vec<u8>, i32> {
    http_exit(ctx, r, api_rule(path))
}

/// 서버 본문을 그대로 stderr 에 싣는다. 본문이 개행으로 끝나지 않으면 하나 붙인다.
pub(crate) fn raw_refusal(w: &mut dyn Write, _status: u16, body: &[u8]) {
    let _ = w.write_all(body);
    if body.last() != Some(&b'\n') {
        let _ = w.write_all(b"\n");
    }
}

/// 서버 거절 본문의 세 방언을 한 번에 읽은 것이다. 필드를 날것으로 두고 렌더러가 자기가
/// 쓰는 것만 푼다.
#[derive(Default, Deserialize)]
#[serde(default, rename = "runtimebin.refusal")]
pub(crate) struct Refusal {
    pub error: Option<RawMessage>,
    pub detail: Option<RawMessage>,
    pub code: Option<RawMessage>,
    pub message: Option<RawMessage>,
    pub unreported: Option<RawMessage>,
    #[serde(rename = "runId")]
    pub run_id: Option<RawMessage>,
    pub stale: Option<RawMessage>,
    #[serde(rename = "memberId")]
    pub member_id: Option<RawMessage>,
    pub state: Option<RawMessage>,
    pub hint: Option<RawMessage>,
}

/// 본문이 JSON 객체(또는 null)일 때만 `Some` 이다.
pub(crate) fn parse_refusal(raw: &[u8]) -> Option<Refusal> {
    json::unmarshal::<Option<Refusal>>(raw)
        .ok()
        .map(Option::unwrap_or_default)
}

/// 날것 필드 하나를 푼다. 필드가 없으면 성공이고 기본값이다.
pub(crate) fn take_field<T: serde::de::DeserializeOwned + Default>(
    f: &Option<RawMessage>,
) -> Option<T> {
    match f {
        None => Some(T::default()),
        Some(m) if m.0.is_empty() => Some(T::default()),
        Some(m) => json::unmarshal::<Option<T>>(&m.0)
            .ok()
            .map(Option::unwrap_or_default),
    }
}

/// `{error}` 를 풀어 보이고, 아니면 본문을 그대로 싣는다.
pub(crate) fn print_api_error(w: &mut dyn Write, status: u16, path: &str, body: &[u8]) {
    if let Some(r) = parse_refusal(body)
        && let Some(msg) = take_field::<String>(&r.error)
        && !msg.is_empty()
    {
        let _ = writeln!(w, "dmctl: {msg}");
        return;
    }
    let _ = write!(w, "dmctl: {path} returned status {status}: ");
    let _ = w.write_all(body);
    let _ = w.write_all(b"\n");
}

/// `{code,message}` 를 풀어 보인다. 상대 노드의 글자가 실리므로 제어 문자를 지운다.
pub(crate) fn print_code_refusal(w: &mut dyn Write, status: u16, raw: &[u8]) {
    if let Some(r) = parse_refusal(raw)
        && let Some(code) = take_field::<String>(&r.code)
        && let Some(msg) = take_field::<String>(&r.message)
        && !code.is_empty()
    {
        let _ = writeln!(w, "dmctl: {}: {}", clean(&code), clean(&msg));
        return;
    }
    let _ = writeln!(
        w,
        "dmctl: status {status}: {}",
        dm_shared_termtext::strip_bytes(raw)
    );
}

pub(crate) fn clean(s: &str) -> String {
    dm_shared_termtext::strip(s)
}
