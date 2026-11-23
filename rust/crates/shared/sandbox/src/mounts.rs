use dm_gocompat::filepath;
use dm_gocompat::fmt::v_value;
use dm_gocompat::strconv::quote;

use crate::{Error, HomeFn, PROFILES_FILE_NAME};

/// 호스트 경로 하나를 컨테이너에 붙이는 항목이다.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Mount {
    pub host: String,
    pub container: String,
    pub read_only: bool,
    /// scratch 프로파일에도 붙인다.
    pub scratch: bool,
}

impl Mount {
    /// `docker -v` 의 값이다.
    pub fn arg(&self) -> String {
        let mut s = format!("{}:{}", self.host, self.container);
        if self.read_only {
            s.push_str(":ro");
        }
        s
    }
}

/// `호스트경로:컨테이너경로[:ro|:rw]` 를 읽는다. `~` 는 사용자 홈으로 편다.
pub fn parse_mount(v: &str, home: &HomeFn) -> Result<Mount, Error> {
    let mut raw = v.trim();
    if raw.is_empty() {
        return Err(Error::msg("빈 마운트 항목입니다"));
    }
    let mut m = Mount::default();
    if let Some(r) = raw.strip_suffix(":ro") {
        m.read_only = true;
        raw = r;
    } else if let Some(r) = raw.strip_suffix(":rw") {
        raw = r;
    }
    let i = raw.rfind(':');
    let Some(i) = i.filter(|&i| i > 0 && i != raw.len() - 1) else {
        return Err(Error::msg(format!(
            "마운트 형식이 아닙니다(호스트경로:컨테이너경로[:ro]): {}",
            quote(v)
        )));
    };
    m.host = raw[..i].to_string();
    m.container = raw[i + 1..].to_string();
    if !m.container.starts_with('/') {
        return Err(Error::msg(format!(
            "컨테이너 경로는 {} 처럼 절대 경로여야 합니다: {}",
            quote("/work"),
            quote(v)
        )));
    }
    m.host = expand_home(&m.host, home)?;
    Ok(m)
}

fn expand_home(p: &str, home: &HomeFn) -> Result<String, Error> {
    if p != "~" && !p.starts_with("~/") && !p.starts_with("~\\") {
        return Ok(p.to_string());
    }
    let Some(h) = home().filter(|h| !h.is_empty()) else {
        return Err(Error::msg(format!(
            "사용자 홈을 알 수 없어 {} 를 펼 수 없습니다",
            quote(p)
        )));
    };
    if p == "~" {
        return Ok(h);
    }
    Ok(filepath::join(&[h.as_str(), &p[2..]]))
}

/// sandbox.json 의 mounts 항목 하나(문자열 또는 객체)다.
pub(crate) fn to_mount(v: &serde_json::Value, home: &HomeFn) -> Result<Mount, Error> {
    use serde_json::Value;
    match v {
        Value::String(t) => parse_mount(t, home),
        Value::Object(t) => {
            let str_of = |k: &str| t.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let bool_of = |k: &str| t.get(k).and_then(Value::as_bool).unwrap_or(false);
            let (host, container) = (str_of("host"), str_of("container"));
            if host.is_empty() || container.is_empty() {
                return Err(Error::msg(format!(
                    "마운트에 host 와 container 가 모두 필요합니다: {}",
                    v_value(v)
                )));
            }
            if !container.starts_with('/') {
                return Err(Error::msg(format!(
                    "컨테이너 경로는 절대 경로여야 합니다: {}",
                    quote(&container)
                )));
            }
            Ok(Mount {
                host: expand_home(&host, home)?,
                container,
                read_only: bool_of("readonly"),
                scratch: bool_of("scratch"),
            })
        }
        _ => Err(Error::msg(format!(
            "마운트 항목을 해석할 수 없습니다: {}",
            v_value(v)
        ))),
    }
}

/// 기본 마운트의 원본이 모두 있는지 본다 (FR-SBX-21: 없으면 띄우지 않는다).
pub fn verify_mounts(ms: &[Mount], stat: &dyn Fn(&str) -> bool) -> Result<(), Error> {
    for m in ms {
        if !stat(&m.host) {
            return Err(Error::msg(format!(
                "기본 마운트의 원본이 없습니다: {} ({PROFILES_FILE_NAME} 를 확인하세요)",
                m.host
            )));
        }
    }
    Ok(())
}
