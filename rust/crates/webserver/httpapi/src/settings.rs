//! `/api/settings` 와 설정 저장소 (Go `handlers_settings.go`).
//!
//! 브라우저 설정은 서버가 해석하지 않는 JSON blob 이다. 서버가 읽는 가지(렌더 환경·맥락 정책·
//! 탭 이름·migration)만 blob 이 바뀔 때 한 번 푼다 (OPTIMIZE_REFACTOR_SRS FR-OPT-8-2 · HTTP-26).

use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use http::{HeaderValue, StatusCode, header};
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_otterlog::infof;
use otter_webserver_apierr as apierr;
use otter_webserver_domain_run::ContextPolicy;
use serde::Deserialize;

use crate::agent_render_env::agent_render_env;
use crate::deps::SettingsStore;
use crate::httperr::{http_err, read_body_err};
use crate::migration_advice::{MigrationConf, parse_migration_conf};
use crate::req::Req;
use crate::{Server, gitwire};

/// 설정 파일의 권한이다 (Go `0644`).
const SETTINGS_FILE_PERM: u32 = 0o644;

/// 서버가 blob 에서 읽는 것 전부다 (Go `settingsView`).
pub(crate) struct SettingsView {
    pub(crate) render_env: Vec<String>,
    pub(crate) policy: ContextPolicy,
    pub(crate) fg_tab_names: bool,
    pub(crate) migration: MigrationConf,
}

struct Inner {
    raw: Vec<u8>,
    /// `set` 이 비우고 `view` 가 처음 물을 때 한 번 푼다.
    parsed: Option<Arc<SettingsView>>,
}

/// Go `settingsStore`: `<dataDir>/settings.json` 에 두는 JSON blob 이다.
pub(crate) struct FileSettings {
    mu: Mutex<Inner>,
    path: PathBuf,
}

impl FileSettings {
    /// Go `newSettingsStore`. 파일이 없으면 빈 blob 이다.
    pub(crate) fn new(path: PathBuf) -> FileSettings {
        let raw = match std::fs::read(&path) {
            Ok(data) => {
                infof!(None, "settings loaded {} bytes", data.len());
                data
            }
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound {
                    infof!(
                        None,
                        "loadSettings: {}",
                        crate::access::go_read_error(&path, &e)
                    );
                }
                Vec::new()
            }
        };
        FileSettings {
            mu: Mutex::new(Inner { raw, parsed: None }),
            path,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.mu.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(crate) fn view(&self) -> Arc<SettingsView> {
        let mut g = self.lock();
        if let Some(v) = &g.parsed {
            return v.clone();
        }
        let v = Arc::new(SettingsView {
            render_env: agent_render_env(&g.raw),
            policy: parse_context_policy(&g.raw),
            fg_tab_names: parse_fg_tab_names(&g.raw),
            migration: parse_migration_conf(&g.raw),
        });
        g.parsed = Some(v.clone());
        v
    }
}

impl SettingsStore for FileSettings {
    fn get(&self) -> Vec<u8> {
        self.lock().raw.clone()
    }

    fn set(&self, blob: Vec<u8>) {
        let mut g = self.lock();
        g.raw = blob;
        g.parsed = None;
    }

    /// 빈 blob 은 쓰지 않는다. 쓰기는 원자적이다 (FR-CAF-11).
    fn save(&self) -> io::Result<()> {
        let data = self.get();
        if data.is_empty() {
            return Ok(());
        }
        otter_shared_platform::write_state_file(&self.path, &data, SETTINGS_FILE_PERM).inspect_err(
            |e| {
                infof!(
                    None,
                    "saveSettings: {}",
                    otter_gocompat::oserr::go_error_string(e)
                )
            },
        )
    }

    fn render_env(&self) -> Vec<String> {
        self.view().render_env.clone()
    }

    fn fg_tab_names(&self) -> bool {
        self.view().fg_tab_names
    }

    fn context_policy(&self) -> ContextPolicy {
        self.view().policy
    }

    fn migration(&self) -> MigrationConf {
        self.view().migration
    }
}

/// Go `parseFgTabNames`: 없거나 읽히지 않으면 켬이다 (CONVENIENCE_SRS FR-TAN-19).
pub(crate) fn parse_fg_tab_names(blob: &[u8]) -> bool {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Cfg {
        #[serde(rename = "fgTabNames")]
        fg_tab_names: Option<bool>,
    }
    otter_gocompat::json::unmarshal::<Cfg>(blob)
        .ok()
        .and_then(|c| c.fg_tab_names)
        .unwrap_or(true)
}

/// Go `parseContextPolicy`: blob 의 정책 가지다 (FR-CBG-2). 읽히지 않으면 기본값이다.
pub(crate) fn parse_context_policy(blob: &[u8]) -> ContextPolicy {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Orch {
        #[serde(rename = "contextBytesPerToken")]
        bpt: f64,
        #[serde(rename = "contextLimitTokens")]
        limit: f64,
        #[serde(rename = "contextWarnRatio")]
        warn: f64,
        #[serde(rename = "contextCriticalRatio")]
        critical: f64,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Cfg {
        orchestration: Orch,
    }
    match otter_gocompat::json::unmarshal::<Cfg>(blob) {
        Ok(c) => ContextPolicy {
            bytes_per_token: c.orchestration.bpt,
            limit_tokens: c.orchestration.limit,
            warn_ratio: c.orchestration.warn,
            critical_ratio: c.orchestration.critical,
        },
        Err(_) => ContextPolicy::default_policy(),
    }
}

impl Server {
    /// GET /api/settings. 비었으면 `{}` 다.
    pub(crate) async fn api_settings_get(&self, _r: &mut Req) -> Response {
        let data = self
            .deps
            .settings
            .as_ref()
            .map(|s| s.get())
            .unwrap_or_default();
        let body = if data.is_empty() {
            b"{}".to_vec()
        } else {
            data
        };
        let mut res = Response::new(httpresp::full(body));
        res.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(httpresp::CONTENT_TYPE_JSON),
        );
        res
    }

    /// PUT /api/settings. JSON 이어야 하고(FR-RQG-16), 사용자 정의 테마의 값은 색이어야 한다
    /// (FR-QG-11). 저장 실패는 500 이다 — 사유는 감춘다 (SEC-17).
    pub(crate) async fn api_settings_put(&self, r: &mut Req) -> Response {
        let body = match r.read_body(0).await {
            Ok(b) => b.to_vec(),
            Err(e) => return read_body_err(&e),
        };
        if !otter_gocompat::json::valid(&body) {
            return http_err(
                "settings must be JSON",
                StatusCode::BAD_REQUEST,
                apierr::CODE_INVALID_JSON,
            );
        }
        if let Some(p) = otter_shared_settingsschema::check_theme_blob(&body) {
            return http_err(
                &format!("{}: {}", p.key, p.reason),
                StatusCode::BAD_REQUEST,
                apierr::CODE_BAD_REQUEST,
            );
        }
        if let Some(s) = self.deps.settings.clone() {
            let saved = crate::tools_api::off_thread(move || {
                s.set(body);
                s.save()
            })
            .await;
            if !matches!(saved, Some(Ok(()))) {
                return http_err(
                    "settings save failed",
                    StatusCode::INTERNAL_SERVER_ERROR,
                    apierr::CODE_SAVE_FAILED,
                );
            }
        }
        // FR-ELR-76: 워크트리 회차 간격은 재시작 없이 다음 회차부터다.
        self.apply_git_worktree();
        // 저장이 끝난 **뒤에** 알린다 (CHANNEL_PROTOCOL C2b).
        self.refresh_full_topic("settings");
        let mut res = Response::new(httpresp::empty());
        *res.status_mut() = StatusCode::OK;
        res
    }

    /// Go `applyGitWorktree`: 지금 설정의 워크트리 회차 간격을 감시자에 얹는다 (FR-ELR-76).
    pub(crate) fn apply_git_worktree(&self) {
        gitwire::apply_git_worktree(self.git_watch.as_ref(), self.deps.settings.as_deref());
    }
}
