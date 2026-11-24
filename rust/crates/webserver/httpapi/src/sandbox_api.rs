//! 샌드박스 종단 (Go `handlers_api.go` 의 sandbox 부분, SANDBOX_SRS·UX_BATCH5_SRS).

use std::collections::BTreeMap;

use http::StatusCode;
use otter_shared_httpresp::Response;
use otter_shared_sandbox::{
    self as sandbox, DevConfig, ExecFn, Mount, ProfileInfo, RUNTIME_MISSING, RUNTIME_OK,
    RuntimeStatus,
};
use otter_webserver_action::{self as action, Answer};
use otter_webserver_apierr as apierr;
use serde::Serialize;

use crate::Server;
use crate::httperr::{fail, fail_read, http_err, write_json};
use crate::req::Req;
use crate::settings_etag::{settings_stale, settings_tag};
use crate::tools_api::{off_thread, with_header};

/// 프로파일 목록이 기본 프로파일 하나뿐인가다 (`1`·`0`, D-SDA-12).
pub(crate) const SANDBOX_ONLY_DEFAULT_HEADER: &str = "X-Sandbox-Only-Default";

const SANDBOX_UNREADY_MSG: &str =
    "샌드박스를 쓸 수 없습니다 — 컨테이너 런타임(docker)을 확인하세요";

/// Go `sandbox.Mount` 의 JSON — 태그가 없어 필드 이름 그대로다.
#[derive(Serialize)]
struct MountJson<'a> {
    #[serde(rename = "Host")]
    host: &'a str,
    #[serde(rename = "Container")]
    container: &'a str,
    #[serde(rename = "ReadOnly")]
    read_only: bool,
    #[serde(rename = "Scratch")]
    scratch: bool,
}

/// Go `sandbox.Config` 의 JSON (`mounts,omitempty`·`dev,omitempty`).
#[derive(Serialize)]
pub(crate) struct ConfigJson<'a> {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    mounts: Vec<MountJson<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dev: Option<&'a DevConfig>,
}

pub(crate) fn config_json(c: &sandbox::Config) -> ConfigJson<'_> {
    ConfigJson {
        mounts: c.mounts.iter().map(mount_json).collect(),
        dev: c.dev.as_ref(),
    }
}

fn mount_json(m: &Mount) -> MountJson<'_> {
    MountJson {
        host: &m.host,
        container: &m.container,
        read_only: m.read_only,
        scratch: m.scratch,
    }
}

/// 상태 응답 — `RuntimeStatus` 의 필드에 시작의 답과 뜻을 얹는다 (K-i).
#[derive(Serialize)]
struct RuntimeJson<'a> {
    state: &'a str,
    os: &'a str,
    runtime: &'a str,
    path: &'a str,
    detail: &'a str,
    #[serde(rename = "installCommand")]
    install_command: &'a str,
    #[serde(rename = "startCommand")]
    start_command: &'a str,
    #[serde(rename = "startTryable")]
    start_tryable: bool,
    ready: bool,
    installed: bool,
    actions: BTreeMap<&'static str, Answer>,
}

/// Go `sandboxStartAnswer` (SERVER_DRIVEN_ACTIONS_SRS X-b).
pub(crate) fn sandbox_start_answer(st: &RuntimeStatus) -> Answer {
    if st.state == RUNTIME_MISSING {
        return action::deny(409, apierr::CODE_RUNTIME_MISSING, None);
    }
    if !st.start_tryable {
        return action::deny(409, apierr::CODE_RUNTIME_START_MANUAL, None);
    }
    action::allow()
}

/// Go `writeSandboxRuntime`.
pub(crate) fn write_sandbox_runtime(st: &RuntimeStatus) -> Response {
    let mut actions = BTreeMap::new();
    actions.insert(action::SANDBOX_RUNTIME_START, sandbox_start_answer(st));
    write_json(&RuntimeJson {
        state: &st.state,
        os: &st.os,
        runtime: &st.runtime,
        path: &st.path,
        detail: &st.detail,
        install_command: &st.install_command,
        start_command: &st.start_command,
        start_tryable: st.start_tryable,
        ready: st.state == RUNTIME_OK,
        installed: st.state != RUNTIME_MISSING,
        actions,
    })
}

/// Go `writeSandboxStart`: 답이 참일 때만 기동한다. 거절은 평문 방언이다.
pub(crate) fn write_sandbox_start(st: &RuntimeStatus, run: &ExecFn<'_>) -> Response {
    let a = sandbox_start_answer(st);
    if !a.ok {
        let status = StatusCode::from_u16(a.status).unwrap_or(StatusCode::CONFLICT);
        return http_err(&a.why, status, &a.why);
    }
    write_json(&sandbox::start_runtime(&st.os, run))
}

fn probe_now() -> RuntimeStatus {
    sandbox::probe(
        otter_shared_platform::current().os.as_str(),
        &sandbox::look_path,
        &sandbox::cli_exec,
    )
}

fn sandbox_unready() -> Response {
    http_err(
        SANDBOX_UNREADY_MSG,
        StatusCode::SERVICE_UNAVAILABLE,
        apierr::CODE_SANDBOX_UNREADY,
    )
}

impl Server {
    /// Go `reapSandboxes`: 살아 있는 Window 목록으로 대응 컨테이너를 회수한다. workspace 를
    /// 읽지 못하면 아무것도 하지 않는다 (FR-SBX-9).
    pub(crate) async fn reap_sandboxes(&self) {
        let (Some(sb), Some(work)) = (self.deps.sandbox.clone(), self.deps.work.clone()) else {
            return;
        };
        let _ = off_thread(move || {
            let Some(ws) = work.windows() else {
                return;
            };
            let live: Vec<String> = ws.into_iter().map(|w| w.uuid).collect();
            sb.reap(&live);
        })
        .await;
    }

    /// GET /api/sandbox/profiles (FR-SBX-25). 런타임이 없으면 빈 목록이다 (NFR-SBX-3).
    pub(crate) async fn api_sandbox_profiles(&self, _r: &mut Req) -> Response {
        let list: Vec<ProfileInfo> = match self.deps.sandbox.clone() {
            Some(sb) => off_thread(move || sb.profiles()).await.unwrap_or_default(),
            None => Vec::new(),
        };
        let only = if sandbox::only_default(&list) {
            "1"
        } else {
            "0"
        };
        with_header(write_json(&list), SANDBOX_ONLY_DEFAULT_HEADER, only)
    }

    /// GET /api/sandbox/runtime (FR-SRT-1). 실패해도 200 이다.
    pub(crate) async fn api_sandbox_runtime(&self, _r: &mut Req) -> Response {
        let st = off_thread(probe_now).await.unwrap_or_default();
        write_sandbox_runtime(&st)
    }

    /// POST /api/sandbox/runtime/start (FR-SRT-3).
    pub(crate) async fn api_sandbox_runtime_start(&self, _r: &mut Req) -> Response {
        off_thread(|| write_sandbox_start(&probe_now(), &sandbox::start_exec))
            .await
            .unwrap_or_else(|| fail(StatusCode::INTERNAL_SERVER_ERROR, "start cancelled", None))
    }

    /// GET /api/sandbox/config (FR-SBX-43).
    pub(crate) async fn api_sandbox_config_get(&self, _r: &mut Req) -> Response {
        let Some(sb) = self.deps.sandbox.clone() else {
            return sandbox_unready();
        };
        match off_thread(move || sb.config()).await {
            Some(Ok(cfg)) => {
                let j = config_json(&cfg);
                with_header(write_json(&j), "ETag", &settings_tag(&j))
            }
            Some(Err(e)) => fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "샌드박스 정의를 읽지 못했습니다",
                Some(&e),
            ),
            None => fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "샌드박스 정의를 읽지 못했습니다",
                None,
            ),
        }
    }

    /// PUT /api/sandbox/config. 검증은 저장 쪽이 한다 — 400 의 사유가 그대로 사용자에게 보인다.
    pub(crate) async fn api_sandbox_config_put(&self, r: &mut Req) -> Response {
        let Some(sb) = self.deps.sandbox.clone() else {
            return sandbox_unready();
        };
        let body = match r.read_body(0).await {
            Ok(b) => b,
            Err(e) => return fail_read(&e),
        };
        let _g = self.sandbox_put.lock().await;
        let cur = self.sandbox_tag().await;
        if settings_stale(r, &cur) {
            return with_header(
                http_err(
                    "stale revision",
                    StatusCode::CONFLICT,
                    apierr::CODE_STALE_REV,
                ),
                "ETag",
                &cur,
            );
        }
        let saved = off_thread(move || sb.save_config(&body)).await;
        match saved {
            Some(Ok(())) => {}
            // 저장 실패의 사유에는 정의 파일의 절대경로가 들어 있다.
            Some(Err(e @ sandbox::Error::SaveFailed)) => {
                return fail(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string(), None);
            }
            // 정의 자체에 대한 말이다 — 사용자가 고칠 수 있다.
            Some(Err(e)) => return fail(StatusCode::BAD_REQUEST, &e.to_string(), None),
            None => return fail(StatusCode::INTERNAL_SERVER_ERROR, "save cancelled", None),
        }
        // FR-LIV-3: 저장이 끝난 뒤에 알린다.
        if let Some(c) = self.commands() {
            c.broadcast(&otter_webserver_sse::payload(
                "sandbox_changed",
                Some(&BTreeMap::<String, ()>::new()),
            ));
        }
        let tag = self.sandbox_tag().await;
        let mut res = Response::new(otter_shared_httpresp::empty());
        *res.status_mut() = StatusCode::NO_CONTENT;
        with_header(res, "ETag", &tag)
    }

    /// Go `sandboxTag`: 지금 저장된 정의의 지문이다. 읽지 못하면 빈 문자열이다.
    async fn sandbox_tag(&self) -> String {
        let Some(sb) = self.deps.sandbox.clone() else {
            return String::new();
        };
        match off_thread(move || sb.config()).await {
            Some(Ok(cfg)) => settings_tag(&config_json(&cfg)),
            _ => String::new(),
        }
    }
}
