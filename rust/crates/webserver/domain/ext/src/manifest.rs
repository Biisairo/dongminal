//! 팩 하나의 선언 (LSP_PLUGIN_SRS FR-EXT-3). **여기에 서버 목록이 없다** (FR-EXT-1) — 매니페스트가
//! 유일한 출처이며, 이 crate 는 선언을 읽어 집행하는 쪽이다 (D-P2).

use std::collections::BTreeMap;

use dm_gocompat::json::{self, is_empty};
use dm_gocompat::{path, strconv::quote};
use serde::{Deserialize, Serialize};

use crate::error::{Error, errorf};
use crate::fetch::STAGING_SUFFIX;

/// 팩 디렉터리 안에서 선언이 사는 파일 이름.
pub const MANIFEST_NAME: &str = "plugin.json";

/// 언어 서버를 내는 팩 (FR-EXT-3).
pub const KIND_SERVER: &str = "server";
/// 서버를 **실행할 것**을 내는 팩 (FR-EXT-6).
pub const KIND_RUNTIME: &str = "runtime";

/// 타깃별 URL 에서 받아 푼다 (FR-EXT-10).
pub const SOURCE_ARCHIVE: &str = "archive";
/// 런타임의 npm 으로 받는다 (FR-EXT-12).
pub const SOURCE_NPM: &str = "npm";
/// 호스트의 도구로 만든다 (§2.3 / D-P4).
pub const SOURCE_TOOLCHAIN: &str = "toolchain";

/// 팩이 내는 언어 서버 하나이며 세션의 단위다 (FR-EXT-4).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "ext.Server")]
pub struct Server {
    pub id: String,
    pub langs: Vec<String>,
    /// 소문자·점 포함으로 정규화된다 (FR-LSP-44).
    pub exts: Vec<String>,
    pub exe: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub args: Vec<String>,
}

/// 한 플랫폼의 조달처 (FR-EXT-11).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "ext.Target")]
pub struct Target {
    pub url: String,
    /// 받은 것을 풀기 전에 대조한다 (FR-EXT-15).
    pub sha256: String,
    #[serde(skip_serializing_if = "is_zero")]
    pub strip: i64,
    #[serde(skip_serializing_if = "is_empty")]
    pub bin: String,
    /// 받은 것이 실행 파일 하나다 (EDITOR_LINK_LSP_SRS FR-ELS-3).
    #[serde(skip_serializing_if = "is_false")]
    pub raw: bool,
    /// 이름 → 상대경로 (runtime 팩). 타깃마다 다르다 (FR-EXT-13).
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub provides: BTreeMap<String, String>,
}

/// 조달 선언.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "ext.Source")]
pub struct Source {
    pub kind: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub packages: Vec<String>,
    #[serde(skip_serializing_if = "is_empty")]
    pub tool: String,
    #[serde(skip_serializing_if = "is_empty")]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "is_empty")]
    pub bin: String,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub targets: BTreeMap<String, Target>,
}

/// 팩 하나의 선언 (FR-EXT-3).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "ext.Manifest")]
pub struct Manifest {
    pub id: String,
    pub kind: String,
    /// 런타임에서는 필수다 — 경로에 박힌다 (FR-EXT-24).
    #[serde(skip_serializing_if = "is_empty")]
    pub version: String,
    /// 이 팩이 서기 전에 확보돼야 할 런타임 id 들 (FR-EXT-7).
    #[serde(skip_serializing_if = "is_empty")]
    pub needs: Vec<String>,
    pub source: Source,
    #[serde(skip_serializing_if = "is_empty")]
    pub servers: Vec<Server>,
}

fn is_zero(v: &i64) -> bool {
    *v == 0
}

fn is_false(v: &bool) -> bool {
    !*v
}

/// 선언 하나를 읽고 **검증까지 한다**. 읽기와 검증이 한 문이다 (FR-EXT-39).
pub fn parse_manifest(blob: &[u8]) -> Result<Manifest, Error> {
    let mut m: Manifest = json::unmarshal(blob)
        .map_err(|e| Error::new(e.to_string()).wrap("선언을 해석할 수 없습니다"))?;
    m.validate()?;
    m.normalize();
    Ok(m)
}

impl Manifest {
    fn validate(&self) -> Result<(), Error> {
        if !valid_segment(&self.id) {
            return Err(errorf!("id 가 경로 한 칸이 아닙니다: {}", quote(&self.id)));
        }
        // 조달의 옆 자리(`<id>.new`)와 겹치면 `X` 의 조달이 팩 `X.new` 를 지운다 (FR-ATF-22).
        if self.id.ends_with(STAGING_SUFFIX) {
            return Err(errorf!(
                "id 는 {} 로 끝날 수 없습니다: {}",
                quote(STAGING_SUFFIX),
                quote(&self.id)
            ));
        }
        match self.kind.as_str() {
            KIND_SERVER => {
                if self.servers.is_empty() {
                    return Err(errorf!(
                        "{}: server 팩이 서버를 하나도 내지 않습니다",
                        self.id
                    ));
                }
                for s in &self.servers {
                    if !valid_segment(&s.id) {
                        return Err(errorf!(
                            "{}: 서버 id 가 온전하지 않습니다: {}",
                            self.id,
                            quote(&s.id)
                        ));
                    }
                    if s.exe.trim().is_empty() {
                        return Err(errorf!("{}/{}: exe 가 없습니다", self.id, s.id));
                    }
                    if s.exe.contains(['/', '\\']) {
                        return Err(errorf!(
                            "{}/{}: exe 는 이름이지 경로가 아닙니다: {}",
                            self.id,
                            s.id,
                            quote(&s.exe)
                        ));
                    }
                }
            }
            KIND_RUNTIME => {
                if self.source.targets.is_empty() {
                    return Err(errorf!("{}: runtime 팩에 타깃이 없습니다", self.id));
                }
                if !valid_segment(&self.version) {
                    return Err(errorf!("{}: runtime 팩에 version 이 없습니다", self.id));
                }
            }
            _ => {
                return Err(errorf!(
                    "{}: 모르는 kind 입니다: {}",
                    self.id,
                    quote(&self.kind)
                ));
            }
        }
        self.source.validate(&self.id, &self.kind)
    }

    /// 표기를 하나로 맞춘다. 확장자가 그 대상이다 (FR-EXT-4).
    fn normalize(&mut self) {
        for s in &mut self.servers {
            for e in &mut s.exts {
                *e = normalize_ext(e);
            }
        }
    }
}

impl Source {
    fn validate(&self, id: &str, kind: &str) -> Result<(), Error> {
        match self.kind.as_str() {
            SOURCE_NPM => {
                if self.packages.is_empty() {
                    return Err(errorf!("{id}: npm 조달에 packages 가 없습니다"));
                }
                for p in &self.packages {
                    if p.trim().is_empty() {
                        return Err(errorf!("{id}: 빈 패키지 명세가 있습니다"));
                    }
                    // 인자로 그대로 나가므로 옵션으로 읽히는 값을 막는다 (FR-EXT-38).
                    if p.starts_with('-') {
                        return Err(errorf!(
                            "{id}: 패키지 명세가 옵션처럼 보입니다: {}",
                            quote(p)
                        ));
                    }
                }
            }
            SOURCE_TOOLCHAIN => {
                if self.tool.trim().is_empty() || self.args.is_empty() {
                    return Err(errorf!("{id}: toolchain 조달에 tool·args 가 필요합니다"));
                }
                if !self.bin.is_empty() {
                    safe_rel(&self.bin)
                        .map_err(|e| e.wrap(format!("{id}: bin 이 격리 칸을 벗어납니다")))?;
                }
            }
            SOURCE_ARCHIVE => {
                if self.targets.is_empty() {
                    return Err(errorf!("{id}: archive 조달에 타깃이 없습니다"));
                }
                for (name, t) in &self.targets {
                    t.validate().map_err(|e| e.wrap(format!("{id}[{name}]")))?;
                    if kind == KIND_RUNTIME && t.provides.is_empty() {
                        return Err(errorf!("{id}[{name}]: runtime 타깃에 provides 가 없습니다"));
                    }
                }
            }
            _ => {
                return Err(errorf!(
                    "{id}: 모르는 조달 방법입니다: {}",
                    quote(&self.kind)
                ));
            }
        }
        Ok(())
    }
}

impl Target {
    pub(crate) fn validate(&self) -> Result<(), Error> {
        // FR-EXT-40: https 만 받는다.
        if !self.url.starts_with("https://") {
            return Err(errorf!("url 이 https 가 아닙니다: {}", quote(&self.url)));
        }
        if !valid_sha256(&self.sha256) {
            return Err(errorf!(
                "sha256 이 64자리 16진수가 아닙니다: {}",
                quote(&self.sha256)
            ));
        }
        if self.strip < 0 {
            return Err(errorf!("strip 이 음수입니다: {}", self.strip));
        }
        if self.raw && (self.bin.is_empty() || self.strip != 0) {
            return Err(errorf!(
                "raw 타깃에는 bin 이 있어야 하고 strip 이 없어야 합니다"
            ));
        }
        if !self.bin.is_empty() {
            safe_rel(&self.bin).map_err(|e| e.wrap("bin"))?;
        }
        for (name, rel) in &self.provides {
            safe_rel(rel).map_err(|e| e.wrap(format!("provides[{name}]")))?;
        }
        Ok(())
    }
}

/// 확장자의 표기를 하나로 맞춘다 — 소문자, 점 포함. 선언을 읽을 때와 파일을 풀 때가 이것을 같이 쓴다.
pub(crate) fn normalize_ext(e: &str) -> String {
    let e = e.trim().to_lowercase();
    if !e.is_empty() && !e.starts_with('.') {
        return format!(".{e}");
    }
    e
}

/// 경로 한 칸으로 쓸 수 있는 이름인가 (FR-EXT-39). 제어문자도 막는다.
fn valid_segment(s: &str) -> bool {
    if s.is_empty() || s == "." || s == ".." {
        return false;
    }
    if s.contains(['/', '\\']) {
        return false;
    }
    !s.chars().any(|r| (r as u32) < 0x20 || r as u32 == 0x7f)
}

/// 격리 칸 안에 머무는 상대경로인가 (FR-EXT-39). 두 OS 에서 같은 답을 내도록 손으로 막는다.
pub(crate) fn safe_rel(p: &str) -> Result<(), Error> {
    if p.trim().is_empty() {
        return Err(Error::new("비었습니다"));
    }
    if dm_gocompat::filepath::is_abs(p) || p.starts_with('/') || p.starts_with('\\') {
        return Err(errorf!("절대경로입니다: {}", quote(p)));
    }
    if p.len() >= 2 && p.as_bytes()[1] == b':' {
        return Err(errorf!("드라이브 경로입니다: {}", quote(p)));
    }
    let c = path::clean(&p.replace('\\', "/"));
    if c == ".." || c.starts_with("../") {
        return Err(errorf!("상위로 올라갑니다: {}", quote(p)));
    }
    Ok(())
}

fn valid_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

/// `GOOS/GOARCH` 를 VS Code 표기의 타깃 이름으로 옮긴다 (D-P5). 모르는 대상은 빈 값이다.
pub fn target_name(build_target: &str) -> String {
    let Some((goos, goarch)) = build_target.split_once('/') else {
        return String::new();
    };
    let os = match goos {
        "darwin" => "darwin",
        "linux" => "linux",
        "windows" => "win32",
        _ => return String::new(),
    };
    let arch = match goarch {
        "amd64" => "x64",
        "arm64" => "arm64",
        "arm" => "armhf",
        _ => return String::new(),
    };
    format!("{os}-{arch}")
}

/// 이 빌드의 타깃 이름.
pub fn current_target() -> String {
    target_name(dm_shared_platform::build_target())
}
