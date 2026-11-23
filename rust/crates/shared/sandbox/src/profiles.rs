use std::collections::HashMap;
use std::io;

use dm_gocompat::fmt::{v_float, v_value};
use dm_gocompat::json;
use dm_gocompat::strconv::quote;
use serde::{Deserialize, Serialize};

use crate::{Error, HomeFn, PROFILE_SCRATCH, Profile, WorkKind, parse_config, scratch};

/// 홈 아래 샌드박스 정의 파일 이름이다.
pub const PROFILES_FILE_NAME: &str = "sandbox.json";
/// 컨테이너 안 작업 폴더다.
pub const CONTAINER_WORKDIR: &str = "/work";

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename = "sandbox.profileFile")]
pub(crate) struct ProfileFile {
    pub image: String,
    pub ports: Option<Vec<serde_json::Value>>,
}

/// 정의 파일을 읽어 프로파일들을 만든다. 파일이 없으면 scratch 하나다.
pub fn load_profiles(
    path: &str,
    read: &dyn Fn(&str) -> io::Result<Vec<u8>>,
    home: &HomeFn,
) -> Result<HashMap<String, Profile>, Error> {
    let blob = match read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return Ok(HashMap::from([(PROFILE_SCRATCH.to_string(), scratch())]));
        }
        Err(e) => {
            return Err(Error::msg(format!(
                "샌드박스 프로파일 정의를 읽을 수 없습니다({path}): {}",
                dm_gocompat::oserr::go_error_string(&e)
            )));
        }
    };
    let cfg = parse_config(&blob, home).map_err(|e| Error::msg(format!("{path}: {e}")))?;
    Ok(cfg.profiles())
}

/// 포트 목록을 문자열로 맞춘다. 숫자는 1~65535 정수만, 문자열은 비지 않은 것만이다.
pub(crate) fn normalize_ports(
    profile: &str,
    input: &[serde_json::Value],
) -> Result<Vec<String>, Error> {
    use serde_json::Value;
    let mut out = Vec::with_capacity(input.len());
    for v in input {
        match v {
            Value::Number(n) => {
                let t = n.as_f64().unwrap_or(f64::NAN);
                if t != t.trunc() || !(1.0..=65535.0).contains(&t) {
                    return Err(Error::msg(format!(
                        "{} 프로파일의 포트가 범위를 벗어났습니다: {}",
                        quote(profile),
                        v_float(t)
                    )));
                }
                #[allow(clippy::cast_possible_truncation)]
                out.push((t as i64).to_string());
            }
            Value::String(t) => {
                if t.is_empty() {
                    return Err(Error::msg(format!(
                        "{} 프로파일에 빈 포트가 있습니다",
                        quote(profile)
                    )));
                }
                out.push(t.clone());
            }
            _ => {
                return Err(Error::msg(format!(
                    "{} 프로파일의 포트를 해석할 수 없습니다: {}",
                    quote(profile),
                    v_value(v)
                )));
            }
        }
    }
    Ok(out)
}

/// 화면이 보는 프로파일 하나다.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "sandbox.ProfileInfo")]
pub struct ProfileInfo {
    pub name: String,
    pub image: String,
    /// 네트워크·마운트·헬퍼가 모두 없는 완전 격리인가다.
    pub isolated: bool,
    pub helper: bool,
    pub work: WorkKind,
    #[serde(rename = "workPicks")]
    pub work_picks: Vec<WorkPick>,
    #[serde(skip_serializing_if = "json::is_empty")]
    pub ports: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "sandbox.WorkPick")]
pub struct WorkPick {
    pub work: WorkKind,
    pub copies: bool,
}

/// 창이 고를 수 있는 작업 방식이다 (UX_BATCH6_SRS FR-SBM-3).
pub const PICKABLE_WORKS: [WorkKind; 2] = [WorkKind::Mount, WorkKind::Copy];

/// 프로파일의 방식이 마운트·복사일 때만 고를 수 있다. 아니면 빈 목록이다.
pub fn work_picks_of(w: WorkKind) -> Vec<WorkPick> {
    if w != WorkKind::Mount && w != WorkKind::Copy {
        return Vec::new();
    }
    PICKABLE_WORKS
        .iter()
        .map(|&k| WorkPick {
            work: k,
            copies: k == WorkKind::Copy,
        })
        .collect()
}

/// 목록이 기본(scratch) 하나뿐인가다.
pub fn only_default(list: &[ProfileInfo]) -> bool {
    list.len() == 1 && list[0].name == PROFILE_SCRATCH
}

impl Profile {
    pub fn info(&self) -> ProfileInfo {
        ProfileInfo {
            name: self.name.clone(),
            image: self.image.clone(),
            isolated: !self.helper && self.network == "none" && self.base_mounts.is_empty(),
            helper: self.helper,
            work: self.work,
            work_picks: work_picks_of(self.work),
            ports: self.ports.clone(),
        }
    }
}
