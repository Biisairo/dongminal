//! `dongminal config set|get` — 바인드를 바꾸고 보는 CLI (HOT_REBIND_SRS FR-HRB-41·42·43).
//!
//! 서버가 돌고 있으면 리바인드 API 를 부르고, 돌고 있지 않으면 `server.json` 만 고친다 (D-HRB-2·3).

use std::io::Write;
use std::path::Path;
use std::time::Duration;

use dm_gocompat::json;
use dm_gocompat::strconv::quote;
use dm_shared_apipath as apipath;
use dm_shared_dmenv as dmenv;
use dm_shared_serverconf as serverconf;
use serde::Deserialize;
use serde_json::json;

use crate::env::Env;
use crate::http::{ALIVE_PROBE_TIMEOUT, ping, post_json};
use crate::options::{DEFAULT_HOST, EXPOSE_HOST, ParseError, atoi, invalid};

const BIND_PORT_MIN: i64 = 1024;
const BIND_PORT_MAX: i64 = 65535;
/// 리바인드 요청 하나의 상한이다. 서버 쪽 목표는 1초다 (NFR-HRB-1).
const BIND_CALL_TIMEOUT: Duration = Duration::from_secs(5);

/// 리바인드 API 의 오류 코드를 사람 말로 옮긴다 (FR-HRB-43).
fn bind_err_text(code: &str) -> Option<&'static str> {
    Some(match code {
        "bind_port_invalid" => "포트는 1024~65535 사이여야 합니다",
        "bind_port_in_use" => "그 포트를 다른 프로세스가 쓰고 있습니다 — 바인드는 그대로입니다",
        "bind_rebind_failed" => "새 호스트로 다시 리슨하지 못해 옛 호스트로 돌아갔습니다",
        "bind_busy" => "다른 바인드 변경이 진행 중입니다 — 잠시 뒤 다시 하세요",
        "bind_local_only" => "바인드는 서버가 도는 컴퓨터에서만 바꿀 수 있습니다",
        "bind_unavailable" => {
            "이 서버는 실행 중에 바인드를 바꿀 수 없습니다 — server.json 을 고친 뒤 다시 띄우세요"
        }
        "save_failed" => "server.json 이나 주소 파일을 쓰지 못했습니다 — 바인드는 그대로입니다",
        _ => return None,
    })
}

/// `set` 의 키와 값을 본다.
pub(crate) fn check_config_set(key: &str, value: &str) -> Result<(), ParseError> {
    match key {
        "port" => {
            if !atoi(value).is_some_and(|n| (BIND_PORT_MIN..=BIND_PORT_MAX).contains(&n)) {
                return Err(invalid(format!(
                    "config set port: {BIND_PORT_MIN}~{BIND_PORT_MAX} 사이의 숫자여야 합니다: {}",
                    quote(value)
                )));
            }
        }
        "expose" => {
            if value != "on" && value != "off" {
                return Err(invalid(format!(
                    "config set expose: on 또는 off 여야 합니다: {}",
                    quote(value)
                )));
            }
        }
        "" => return Err(invalid("config set: 키가 필요합니다 (port|expose)")),
        _ => {
            return Err(invalid(format!(
                "config set: 알 수 없는 키 {} (port|expose)",
                quote(key)
            )));
        }
    }
    Ok(())
}

/// 주소 파일이 가리키고 실제로 답하는 서버의 URL 이다.
fn running_server(home: &Path) -> Option<String> {
    let (h, p) = serverconf::read_addr(home)?;
    let u = dmenv::base_url(&h, &p);
    ping(&format!("{u}{}", apipath::PING), ALIVE_PROBE_TIMEOUT).then_some(u)
}

pub(crate) fn run_config_set(
    home: &str,
    key: &str,
    value: &str,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let (body, host, port) = if key == "port" {
        (json!({ "port": atoi(value).unwrap_or(0) }), "", value)
    } else {
        let on = value == "on";
        let host = if on { EXPOSE_HOST } else { DEFAULT_HOST };
        (json!({ "expose": on }), host, "")
    };
    let home_path = Path::new(home);
    if let Some(url) = running_server(home_path) {
        return call_bind(&url, &body, stdout, stderr);
    }
    if let Err(e) = serverconf::set_bind(home_path, host, port) {
        let _ = writeln!(stderr, "{} 를 쓰지 못했습니다: {e}", serverconf::FILE_NAME);
        return 1;
    }
    let _ = writeln!(
        stdout,
        "서버가 돌고 있지 않아 {} 만 고쳤습니다 — 다음 기동부터 씁니다",
        serverconf::FILE_NAME
    );
    if host == EXPOSE_HOST {
        let _ = writeln!(
            stderr,
            "⚠ 인증이 없습니다 — 같은 망의 누구나 셸을 얻습니다. Settings ▸ Access 에서 허용 목록을 켜세요"
        );
    }
    0
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct BindReply {
    host: String,
    port: String,
    expose: bool,
    url: String,
    warning: String,
    code: String,
    message: String,
}

/// `POST /api/server/bind` 를 부른다.
fn call_bind(
    url: &str,
    body: &serde_json::Value,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let raw = match json::marshal(body) {
        Ok(r) => r,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    let resp = match post_json(
        &format!("{url}{}", apipath::SERVER_BIND),
        raw,
        BIND_CALL_TIMEOUT,
    ) {
        Ok(r) => r,
        Err(e) => {
            let _ = writeln!(stderr, "서버에 닿지 못했습니다: {e}");
            return 1;
        }
    };
    let out: BindReply = json::unmarshal(&resp.body).unwrap_or_default();
    if resp.status != 200 {
        let msg = match bind_err_text(&out.code) {
            Some(m) => m.to_owned(),
            None => format!("{} ({})", out.message, resp.status),
        };
        let _ = writeln!(stderr, "❌ {msg}");
        return 1;
    }
    let _ = writeln!(
        stdout,
        "✅ 바인드 {} ({}) — {}",
        join_host_port(&out.host, &out.port),
        expose_word(out.expose),
        out.url
    );
    if !out.warning.is_empty() {
        let _ = writeln!(stderr, "⚠ {}", out.warning);
    }
    0
}

/// Go `net.JoinHostPort` — 콜론이 든 호스트는 대괄호로 싼다.
fn join_host_port(host: &str, port: &str) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn expose_word(on: bool) -> &'static str {
    if on { "expose 켜짐" } else { "expose 꺼짐" }
}

/// 지금 바인드와 server.json 의 값을 함께 보인다 (FR-HRB-42).
pub(crate) fn run_config_get(home: &str, env: &Env<'_>, stdout: &mut dyn Write) -> i32 {
    let home_path = Path::new(home);
    match serverconf::read_addr(home_path) {
        Some((h, p))
            if ping(
                &format!("{}{}", dmenv::base_url(&h, &p), apipath::PING),
                ALIVE_PROBE_TIMEOUT,
            ) =>
        {
            let _ = writeln!(
                stdout,
                "지금 바인드: {} ({})",
                join_host_port(&h, &p),
                expose_word(dmenv::is_exposed_host(&h))
            );
        }
        _ => {
            let _ = writeln!(stdout, "지금 바인드: 서버가 돌고 있지 않습니다");
        }
    }
    let getenv = |k: &str| env.get(k);
    let conf = serverconf::resolve(&serverconf::Inputs {
        home: home_path,
        getenv: Some(&getenv),
        ..Default::default()
    });
    let _ = writeln!(
        stdout,
        "{}: host {} ({}) · port {} ({})",
        serverconf::FILE_NAME,
        conf.host.value,
        conf.host.source,
        conf.port.value,
        conf.port.source
    );
    for w in &conf.warnings {
        let _ = writeln!(stdout, "⚠ {w}");
    }
    0
}
