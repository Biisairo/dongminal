//! `~/.claude.json` 의 `oauthAccount`.

use std::collections::BTreeMap;
use std::io;
use std::path::Path;

use otter_gocompat::json::{self, RawMessage};
use serde::Deserialize;

use crate::error::Error;
use crate::{FILE_MODE, fsutil};

const OAUTH_ACCOUNT_KEY: &str = "oauthAccount";
const ERR_CONFIG_CORRUPT: &str = "Claude 설정 파일을 읽을 수 없습니다";

/// `~/.claude.json` 의 `oauthAccount` 다. `raw` 가 원문이다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct OAuthAccount {
    #[serde(skip)]
    pub raw: RawMessage,
    #[serde(rename = "emailAddress")]
    pub email_address: String,
    #[serde(rename = "organizationUuid")]
    pub organization_uuid: String,
    #[serde(rename = "accountUuid")]
    pub account_uuid: String,
    #[serde(rename = "organizationName")]
    pub organization_name: String,
}

type ConfigMap = BTreeMap<String, RawMessage>;

pub(crate) fn read_config_map(path: &Path) -> Result<Option<ConfigMap>, Error> {
    let b = match fsutil::read_file(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    match json::unmarshal::<Option<ConfigMap>>(&b) {
        Ok(Some(m)) => Ok(Some(m)),
        _ => Err(Error::new(ERR_CONFIG_CORRUPT)),
    }
}

/// 설정 파일의 `oauthAccount` 다. 파일이나 키가 없으면 `Ok(None)` 이다.
pub fn read_oauth_account(path: &Path) -> Result<Option<OAuthAccount>, Error> {
    let Some(m) = read_config_map(path)? else {
        return Ok(None);
    };
    let Some(raw) = m.get(OAUTH_ACCOUNT_KEY).filter(|r| r.0 != b"null") else {
        return Ok(None);
    };
    let mut a =
        json::unmarshal::<OAuthAccount>(&raw.0).map_err(|_| Error::new(ERR_CONFIG_CORRUPT))?;
    a.raw = raw.clone();
    Ok(Some(a))
}

/// `oauthAccount` 키만 acct 로 바꾸고(`None` 이면 지우고) 직전 값을 돌려준다. 다른 키는 그대로
/// 둔다. 읽을 수 없는 파일은 덮어쓰지 않는다 (FR-CAC-30 ⑥).
pub fn splice_oauth_account(path: &Path, acct: Option<&RawMessage>) -> Result<RawMessage, Error> {
    let mut m = read_config_map(path)?.unwrap_or_default();
    let prev = match acct {
        None => m.remove(OAUTH_ACCOUNT_KEY),
        Some(a) => m.insert(OAUTH_ACCOUNT_KEY.to_owned(), a.clone()),
    };
    let b = json::marshal_indent(&m, "", "  ").map_err(|e| Error::from(e).wrap("claude config"))?;
    otter_shared_platform::write_file_atomic(path, &b, FILE_MODE)?;
    Ok(prev.unwrap_or_default())
}
