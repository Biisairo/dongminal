use std::collections::{BTreeMap, HashMap};

use dm_gocompat::json::{self, GoTyped, RawMessage};
use dm_gocompat::strconv::quote;
use serde::{Deserialize, Serialize};

use crate::mounts::to_mount;
use crate::profiles::{ProfileFile, normalize_ports};
use crate::{Error, HomeFn, Mount, PROFILE_DEV, PROFILE_SCRATCH, Profile, WorkKind, scratch};

dm_gocompat::go_type!(RawMapType = "map[string]json.RawMessage");

/// sandbox.json 의 내용이다 (SANDBOX_SRS FR-SBX-3).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Config {
    pub mounts: Vec<Mount>,
    pub dev: Option<DevConfig>,
    home: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "sandbox.DevConfig")]
pub struct DevConfig {
    pub image: String,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub ports: Vec<String>,
}

/// sandbox.json 을 읽는다. 비었으면 빈 설정이다. scratch 는 재정의할 수 없다.
pub fn parse_config(blob: &[u8], home: &HomeFn<'_>) -> Result<Config, Error> {
    let mut cfg = Config::default();
    if let Some(h) = home() {
        cfg.home = h;
    }
    if String::from_utf8_lossy(blob).trim().is_empty() {
        return Ok(cfg);
    }
    let raw: Option<BTreeMap<String, RawMessage>> = json::unmarshal::<GoTyped<RawMapType, _>>(blob)
        .map_err(|e| Error::msg(format!("샌드박스 정의를 해석할 수 없습니다: {e}")))?
        .into_inner();
    for (name, body) in raw.unwrap_or_default() {
        match name.as_str() {
            "mounts" => {
                let items: Option<Vec<serde_json::Value>> = json::unmarshal(&body.0)
                    .map_err(|e| Error::msg(format!("mounts 를 해석할 수 없습니다: {e}")))?;
                for it in items.unwrap_or_default() {
                    cfg.mounts.push(to_mount(&it, home)?);
                }
            }
            PROFILE_SCRATCH => {
                return Err(Error::msg(format!(
                    "{} 프로파일은 재정의할 수 없습니다 — 유일한 격리 경계이므로 그 정책이 설정으로 바뀌어서는 안 됩니다(마운트는 항목의 \"scratch\" 표식으로 더합니다)",
                    quote(&name)
                )));
            }
            PROFILE_DEV => {
                let pf: ProfileFile = json::unmarshal(&body.0).map_err(|e| {
                    Error::msg(format!(
                        "{} 프로파일을 해석할 수 없습니다: {e}",
                        quote(&name)
                    ))
                })?;
                if pf.image.is_empty() {
                    return Err(Error::msg(format!(
                        "{} 프로파일에 이미지가 없습니다 — 이 프로파일의 쓸모는 전적으로 이미지 내용물에 달려 있어 기본값을 둘 수 없습니다 (FR-SBX-3)",
                        quote(&name)
                    )));
                }
                let ports = normalize_ports(&name, pf.ports.as_deref().unwrap_or_default())?;
                cfg.dev = Some(DevConfig {
                    image: pf.image,
                    ports,
                });
            }
            _ => {
                return Err(Error::msg(format!(
                    "알 수 없는 샌드박스 프로파일입니다: {} ({PROFILE_DEV} 만 정의할 수 있습니다)",
                    quote(&name)
                )));
            }
        }
    }
    Ok(cfg)
}

#[derive(Serialize)]
struct MountOut<'a> {
    host: String,
    container: &'a str,
    #[serde(rename = "readonly", skip_serializing_if = "json::is_empty")]
    read_only: bool,
    #[serde(skip_serializing_if = "json::is_empty")]
    scratch: bool,
}

#[derive(Serialize)]
struct ConfigOut<'a> {
    #[serde(skip_serializing_if = "json::is_empty")]
    mounts: Vec<MountOut<'a>>,
    #[serde(skip_serializing_if = "json::is_empty")]
    dev: Option<&'a DevConfig>,
}

impl Config {
    /// 정규화한 sandbox.json 이다(2칸 들여쓰기). 홈 아래 경로는 `~` 로 줄인다.
    pub fn encode(&self) -> Result<Vec<u8>, json::Error> {
        let out = ConfigOut {
            mounts: self
                .mounts
                .iter()
                .map(|m| MountOut {
                    host: self.shrink_home(&m.host),
                    container: &m.container,
                    read_only: m.read_only,
                    scratch: m.scratch,
                })
                .collect(),
            dev: self.dev.as_ref(),
        };
        json::marshal_indent(&out, "", "  ")
    }

    fn shrink_home(&self, p: &str) -> String {
        if self.home.is_empty() || !p.starts_with(&self.home) {
            return p.to_string();
        }
        let rest = &p[self.home.len()..];
        match rest.as_bytes().first() {
            None => "~".to_string(),
            Some(b'/' | b'\\') => format!("~/{}", rest.trim_start_matches(['/', '\\'])),
            Some(_) => p.to_string(),
        }
    }

    /// 프로파일들이다. scratch 는 언제나 있고, dev 는 정의했을 때만 있다.
    pub fn profiles(&self) -> HashMap<String, Profile> {
        let mut sc = scratch();
        sc.base_mounts
            .extend(self.mounts.iter().filter(|m| m.scratch).cloned());
        let mut out = HashMap::from([(PROFILE_SCRATCH.to_string(), sc)]);
        if let Some(d) = &self.dev {
            out.insert(
                PROFILE_DEV.to_string(),
                Profile {
                    name: PROFILE_DEV.into(),
                    image: d.image.clone(),
                    network: "bridge".into(),
                    ports: d.ports.clone(),
                    work: WorkKind::Mount,
                    helper: true,
                    base_mounts: self.mounts.clone(),
                },
            );
        }
        out
    }
}
