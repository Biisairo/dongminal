//! `dongminal config` — 설정을 보고 대조하는 자리 (CONFIG_MANAGEMENT_SRS 묶음 C).
//!
//! 서버는 settings.json 을 런타임에 해석하지 않는다(D-CFG-1). 여기서 읽는 것은 사람이 부를 때만
//! 도는 진단이다.

use std::io::{self, Read, Write};
use std::path::Path;

use dm_gocompat::filepath;
use dm_gocompat::json::{self, Encoder};
use dm_gocompat::oserr::{go_error_string, path_error};
use dm_gocompat::strconv::quote;
use dm_shared_dmenv as dmenv;
use dm_shared_serverconf as serverconf;
use dm_shared_settingsschema as settingsschema;
use serde::Serialize;

use crate::config_bind::{check_config_set, run_config_get, run_config_set};
use crate::env::Env;
use crate::options::{Common, ParseError, default_log_file, invalid, unknown_flag};

/// `dongminal config` 의 옵션이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfigOpts {
    pub common: Common,
    /// `show`·`validate`·`set`·`get` 이다.
    pub sub: String,
    pub json: bool,
    /// `set` 의 인자다 (FR-HRB-41).
    pub key: String,
    pub value: String,
}

const CONFIG_SUBS: [&str; 4] = ["show", "validate", "set", "get"];

/// `config <show|validate|set|get> [--json] [--home …]` 를 읽는다.
pub fn parse_config(args: &[String]) -> Result<ConfigOpts, ParseError> {
    let mut o = ConfigOpts::default();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-h" || a == "--help" {
            return Err(ParseError::Help);
        } else if a == "--json" {
            o.json = true;
        } else if a.starts_with('-') {
            if !o.common.take(args, &mut i)? {
                return Err(unknown_flag("config", a));
            }
        } else if o.sub.is_empty() {
            o.sub = a.to_owned();
        } else if o.sub == "set" && o.key.is_empty() {
            o.key = a.to_owned();
        } else if o.sub == "set" && o.value.is_empty() {
            o.value = a.to_owned();
        } else {
            return Err(invalid(format!("config: 인자가 너무 많습니다: {a}")));
        }
        i += 1;
    }
    let subs = CONFIG_SUBS.join("|");
    if o.sub.is_empty() {
        return Err(invalid(format!("config: 하위 명령이 필요합니다 ({subs})")));
    }
    if !CONFIG_SUBS.contains(&o.sub.as_str()) {
        return Err(invalid(format!(
            "config: 알 수 없는 하위 명령 {} ({subs})",
            quote(&o.sub)
        )));
    }
    if o.sub == "set" {
        check_config_set(&o.key, &o.value)?;
    }
    Ok(o)
}

/// 두 하위 명령이 함께 쓰는 재료다. `--json` 이 사람이 읽는 표와 같은 사실을 낸다 (FR-CFG-11).
#[derive(Serialize)]
struct ConfigReport {
    home: String,
    server: serverconf::Resolved,
    #[serde(rename = "settingsProblems", skip_serializing_if = "json::is_empty")]
    settings: Vec<settingsschema::Problem>,
    #[serde(rename = "settingsUnknownKeys", skip_serializing_if = "json::is_empty")]
    unknown: Vec<String>,
    #[serde(skip_serializing_if = "json::is_empty")]
    schema: Vec<settingsschema::Spec>,
    #[serde(skip_serializing_if = "json::is_empty")]
    warnings: Vec<String>,
    #[serde(skip_serializing_if = "json::is_empty")]
    errors: Vec<String>,
}

/// `dongminal config` 다.
pub fn run_config(o: &ConfigOpts, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    run_config_in(o, &Env::process(), stdout, stderr)
}

pub(crate) fn run_config_in(
    o: &ConfigOpts,
    env: &Env<'_>,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let home = match o.common.resolve_home_in(env) {
        Ok(h) => h,
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    };
    match o.sub.as_str() {
        "set" => return run_config_set(&home, &o.key, &o.value, stdout, stderr),
        "get" => return run_config_get(&home, env, stdout),
        _ => {}
    }
    let getenv = |k: &str| env.get(k);
    let log = default_log_file(&home);
    let server = serverconf::resolve(&serverconf::Inputs {
        home: Path::new(&home),
        flag_port: &o.common.port,
        getenv: Some(&getenv),
        default_log_file: &log,
        ..Default::default()
    });
    let mut rep = ConfigReport {
        warnings: server.warnings.clone(),
        errors: server.err().map(|e| e.to_string()).into_iter().collect(),
        home,
        server,
        settings: Vec::new(),
        unknown: Vec::new(),
        schema: Vec::new(),
    };

    match settingsschema::load() {
        // 표를 읽지 못하면 블롭을 댈 기준이 없다. 사용자의 설정이 아니라 빌드의 결함이므로 오류다.
        Err(e) => rep.errors.push(e.to_string()),
        Ok(specs) => {
            let path = filepath::join(&[rep.home.as_str(), dmenv::SETTINGS_FILE]);
            match read_file(&path) {
                Ok(blob) => match settingsschema::validate(&specs, &blob) {
                    Ok((probs, unknown)) => {
                        rep.settings = probs;
                        rep.unknown = unknown;
                    }
                    Err(e) => rep.errors.push(format!("settings.json: {e}")),
                },
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => rep.warnings.push(format!(
                    "settings.json 을 읽지 못했습니다: {}",
                    go_error_string(&e)
                )),
            }
            rep.schema = specs;
        }
    }

    if o.json {
        emit_json(o, rep, stdout, stderr)
    } else {
        emit_text(o, rep, stdout, stderr)
    }
}

/// Go `os.ReadFile` 다. 오류는 여는 단계와 읽는 단계를 가른 `*PathError` 다.
fn read_file(path: &str) -> io::Result<Vec<u8>> {
    let mut f = std::fs::File::open(path).map_err(|e| path_error("open", path, e))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)
        .map_err(|e| path_error("read", path, e))?;
    Ok(buf)
}

fn emit_json(
    o: &ConfigOpts,
    mut rep: ConfigReport,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    if o.sub == "show" {
        // show 의 관심은 실효값이다.
        rep.schema.clear();
    }
    let mut enc = Encoder::new();
    enc.set_indent("", "  ");
    match enc.encode(&rep) {
        Ok(buf) => {
            let _ = stdout.write_all(&buf);
        }
        Err(e) => {
            let _ = writeln!(stderr, "{e}");
            return 1;
        }
    }
    config_exit(o, &rep)
}

fn emit_text(
    o: &ConfigOpts,
    mut rep: ConfigReport,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> i32 {
    let _ = write!(stdout, "홈: {}\n\n", rep.home);
    if o.sub == "show" {
        // 출처가 값보다 중요하다 (FR-CFG-7).
        let _ = writeln!(
            stdout,
            "서버 기동값 (플래그 > 환경변수 > 파일 > 기본값 — host·port 는 환경변수를 보지 않는다)"
        );
        let (k, v, s) = ("키", "값", "출처");
        let _ = writeln!(stdout, "  {k:<10} {v:<28} {s}");
        let s = &rep.server;
        for (name, v) in [
            ("host", &s.host),
            ("port", &s.port),
            ("logLevel", &s.log_level),
            ("logFile", &s.log_file),
        ] {
            let mut src = v.source.to_string();
            if !v.env.is_empty() {
                src.push_str(&format!(" ({})", v.env));
            }
            let _ = writeln!(stdout, "  {name:<10} {:<28} {src}", v.value);
        }
        let _ = writeln!(stdout);
    }

    if o.sub == "validate" {
        let _ = writeln!(
            stdout,
            "서버 기동값: {}",
            if rep.errors.is_empty() {
                "정상"
            } else {
                "오류"
            }
        );
        let _ = writeln!(
            stdout,
            "설정 블롭(settings.json): 불일치 {}건",
            rep.settings.len()
        );
        // 첫 오류에서 멈추지 않는다 (FR-CFG-8).
        for p in &rep.settings {
            let _ = writeln!(stdout, "  ✗ {p}");
        }
        if !rep.unknown.is_empty() {
            rep.unknown.sort();
            // D-CFG-4: 경고이지 실패가 아니다.
            let _ = writeln!(
                stdout,
                "  ℹ 알 수 없는 키 {}개 (실패가 아닙니다): {}",
                rep.unknown.len(),
                rep.unknown.join(", ")
            );
        }
        let _ = writeln!(stdout);
    }

    for w in &rep.warnings {
        let _ = writeln!(stdout, "⚠ {w}");
    }
    for e in &rep.errors {
        let _ = writeln!(stderr, "✗ {e}");
    }
    config_exit(o, &rep)
}

/// `show` 는 보여 주는 명령이라 값이 틀려도 0 이다. 판정은 `validate` 의 일이다 (FR-CFG-9).
fn config_exit(o: &ConfigOpts, rep: &ConfigReport) -> i32 {
    if o.sub != "validate" {
        return 0;
    }
    if !rep.errors.is_empty() || !rep.settings.is_empty() {
        return 1;
    }
    0
}
