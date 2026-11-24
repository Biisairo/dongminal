//! 상태·도구·워크스페이스·지표 종단 (Go `handlers_api.go` 의 나머지와 `handlers_tools_kill.go`).

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime};

use http::{HeaderValue, StatusCode};
use otter_gocompat::json::RawMessage;
use otter_shared_httpreq as httpreq;
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_toolhub::{Placement, ToolInfo, parse_size};
use otter_shared_workspace::Error as WorkspaceError;
use otter_webserver_apierr as apierr;
use serde::{Deserialize, Serialize};

use crate::Server;
use crate::httperr::{BodyRead, fail, http_err, read_body_err, read_body_http, write_json};
use crate::req::Req;
use crate::toolhub::ToolError;

/// `GET /api/tools/busy` 한 번에 물을 수 있는 도구 수의 상한이다 (Go `maxBusyIDs`).
pub(crate) const MAX_BUSY_IDS: usize = 256;
/// SIGTERM 과 SIGKILL 사이의 유예다 (Go `serverLimits.toolKillGrace`, FR-BGK-7).
pub(crate) const TOOL_KILL_GRACE: Duration = Duration::from_secs(3);

const NANOS_PER_MINUTE: i128 = 60 * 1_000_000_000;
const NANOS_PER_HOUR: i128 = 60 * NANOS_PER_MINUTE;

/// 블로킹 호출을 워커 밖에서 돌린다. 패닉은 그대로 전한다(Go 의 패닉 → 복구 미들웨어 500).
pub(crate) async fn off_thread<T, F>(f: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(v) => Some(v),
        Err(e) if e.is_panic() => std::panic::resume_unwind(e.into_panic()),
        Err(_) => None,
    }
}

pub(crate) fn with_header(mut res: Response, name: &'static str, value: &str) -> Response {
    if let Ok(v) = HeaderValue::from_str(value) {
        res.headers_mut().insert(name, v);
    }
    res
}

fn empty(status: StatusCode) -> Response {
    let mut res = Response::new(httpresp::empty());
    *res.status_mut() = status;
    res
}

/// Go `fmtDuration`. `nanos` 는 부호 있는 `time.Duration` 이다.
pub(crate) fn fmt_duration(nanos: i128) -> String {
    let hours = go_hours(nanos);
    let minutes = go_minutes(nanos);
    if hours >= 24.0 {
        format!("{}d {}h", (hours / 24.0) as i64, (hours as i64) % 24)
    } else if hours >= 1.0 {
        format!("{}h {}m", hours as i64, (minutes as i64) % 60)
    } else {
        format!("{}m", minutes as i64)
    }
}

/// Go `Duration.Hours`.
fn go_hours(d: i128) -> f64 {
    (d / NANOS_PER_HOUR) as f64 + (d % NANOS_PER_HOUR) as f64 / NANOS_PER_HOUR as f64
}

/// Go `Duration.Minutes`.
fn go_minutes(d: i128) -> f64 {
    (d / NANOS_PER_MINUTE) as f64 + (d % NANOS_PER_MINUTE) as f64 / NANOS_PER_MINUTE as f64
}

/// Go `time.Since(t)` 의 나노초 (부호 있음).
fn since(t: SystemTime) -> i128 {
    match SystemTime::now().duration_since(t) {
        Ok(d) => d.as_nanos() as i128,
        Err(e) => -(e.duration().as_nanos() as i128),
    }
}

/// Go `getStats` 의 map — 키 이름 순으로 둔다. 한 번도 유효하지 않았던 지표는 뺀다 (FR-STAT-7).
#[derive(Serialize, Default)]
pub(crate) struct Stats {
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu: Option<f64>,
    #[serde(rename = "diskPct", skip_serializing_if = "Option::is_none")]
    disk_pct: Option<f64>,
    hostname: String,
    /// `?jobs=1` 일 때 진행 중 git 작업이다 — Go 의 map 키 순서(바이트 순) 자리다.
    #[serde(skip_serializing_if = "Option::is_none")]
    jobs: Option<Vec<otter_webserver_domain_git_jobs::Job>>,
    #[serde(rename = "memTotal", skip_serializing_if = "Option::is_none")]
    mem_total: Option<u64>,
    #[serde(rename = "memUsed", skip_serializing_if = "Option::is_none")]
    mem_used: Option<u64>,
    #[serde(rename = "srvUptime")]
    srv_uptime: String,
    #[serde(rename = "sysUptime", skip_serializing_if = "Option::is_none")]
    sys_uptime: Option<String>,
}

/// GET /api/state 의 본문이다 (Go `stateResponse`).
#[derive(Serialize)]
struct StateResponse {
    tools: Option<Vec<ToolInfo>>,
    /// TOOL_LIST_UNKNOWN_SRS FR-TLU-1: 목록을 믿어도 되는가.
    #[serde(rename = "toolsKnown")]
    tools_known: bool,
    workspace: RawMessage,
    #[serde(rename = "fgTabNames", skip_serializing_if = "Option::is_none")]
    fg_tab_names: Option<bool>,
}

#[derive(Serialize)]
struct Created {
    id: String,
    name: String,
}

#[derive(Serialize)]
struct Busy {
    busy: bool,
}

#[derive(Serialize)]
struct BusyMany {
    busy: BTreeMap<String, bool>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct KillBody {
    #[serde(rename = "toolId")]
    tool_id: String,
}

#[derive(Serialize)]
struct OkTrue {
    ok: bool,
}

fn tools_unready() -> Response {
    http_err(
        "tools unavailable",
        StatusCode::INTERNAL_SERVER_ERROR,
        apierr::CODE_TOOLS_UNREADY,
    )
}

impl Server {
    /// workspace.json 의 바이트와 개정이다. 저장소가 없으면 빈 값과 0 이다.
    fn work_snapshot(&self) -> (Vec<u8>, u64) {
        match self.work() {
            Some(w) => {
                let (b, rev) = w.snapshot();
                (b.to_vec(), rev)
            }
            None => (Vec::new(), 0),
        }
    }

    /// Go `getStats`: 상태바 지표를 조립한다. 커널을 부르지 않는다 (FR-STAT-9·10·11).
    pub(crate) fn get_stats(&self) -> Stats {
        let mut out = Stats {
            hostname: otter_shared_platform::hostname().unwrap_or_default(),
            srv_uptime: fmt_duration(self.started.elapsed().as_nanos() as i128),
            ..Stats::default()
        };
        let Some(st) = self.deps.stats.as_ref() else {
            return out;
        };
        let snap = st.snapshot();
        if snap.cpu_valid {
            out.cpu = Some(snap.cpu);
        }
        if snap.mem_valid {
            out.mem_used = Some(snap.mem_used);
        }
        // 총량만 읽힌 부분 성공도 낸다 (FR-ATF-44).
        if snap.mem_valid || snap.mem_total_valid {
            out.mem_total = Some(snap.mem_total);
        }
        if snap.disk_valid {
            out.disk_pct = Some(snap.disk_pct);
        }
        if let Some(boot) = snap.boot_time {
            out.sys_uptime = Some(fmt_duration(since(boot)));
        }
        out
    }

    /// GET /api/stats. `?jobs=1` 이면 진행 중 git 작업 목록을 함께 싣는다 — git 이 없으면 키를
    /// 싣지 않는다 (OPTIMIZE_REFACTOR_SRS FR-OPT-4-4).
    pub(crate) async fn api_stats(&self, r: &mut Req) -> Response {
        let mut out = self.get_stats();
        if r.q("jobs") == "1" {
            out.jobs = self.deps.git.as_ref().and_then(|g| g.active_jobs());
        }
        write_json(&out)
    }

    /// GET /api/state.
    pub(crate) async fn api_state_get(&self, r: &mut Req) -> Response {
        let Some(hub) = self.tools(Some(r)) else {
            return tools_unready();
        };
        let (raw_ws, rev) = self.work_snapshot();
        // FR-OPT-8-6: blob 을 풀었다 다시 쓰지 않는다. 깨진 blob 은 null 이다.
        let workspace = if !raw_ws.is_empty() && otter_gocompat::json::valid(&raw_ws) {
            RawMessage(raw_ws)
        } else {
            RawMessage(b"null".to_vec())
        };
        let listed = off_thread(move || hub.list_ok()).await.flatten();
        let body = StateResponse {
            tools_known: listed.is_some(),
            tools: listed,
            workspace,
            fg_tab_names: self.deps.settings.as_ref().map(|s| s.fg_tab_names()),
        };
        with_header(write_json(&body), "ETag", &rev.to_string())
    }

    /// POST /api/tools.
    pub(crate) async fn api_tools_create(&self, r: &mut Req) -> Response {
        let Some(hub) = self.tools(Some(r)) else {
            return tools_unready();
        };
        let q = r.query();
        let (cols, rows) = parse_size(Some(&q.get_or_empty("cols")), Some(&q.get_or_empty("rows")));
        // explicit_cwd 는 사용자가 고른 자리, cwd 는 `cwdTool` 폴백까지 거친 자리다.
        let explicit_cwd = q.get_or_empty("cwd");
        let mut cwd = explicit_cwd.clone();
        if cwd.is_empty() {
            let ref_id = q.get_or_empty("cwdTool");
            if !ref_id.is_empty() {
                let h = hub.clone();
                cwd = off_thread(move || h.cwd(&ref_id)).await.unwrap_or_default();
            }
        }
        // M8_UNIFIED_SRS D-A-7: 명시한 `cwd` 가 디렉터리가 아니면 400 이다. 샌드박스는
        // 배치기가 판정한다 (FR-SBX-41).
        let profile = q.get_or_empty("sandbox");
        if !explicit_cwd.is_empty() && profile.is_empty() {
            let is_dir = std::fs::metadata(&explicit_cwd).is_ok_and(|m| m.is_dir());
            if !is_dir {
                return http_err(
                    &format!("cwd is not a directory: {explicit_cwd}"),
                    StatusCode::BAD_REQUEST,
                    apierr::CODE_TOOL_CWD_MISSING,
                );
            }
        }
        // FR-SBX-11·FR-SBM-3·FR-ARE-1.
        let place = Placement {
            window_uuid: q.get_or_empty("window"),
            profile,
            work: q.get_or_empty("sandboxWork"),
            extra_env: self.render_env(),
            ..Placement::default()
        };
        let created = off_thread(move || hub.create(&cwd, cols, rows, &place))
            .await
            .unwrap_or_else(|| Err(ToolError::Other("create cancelled".to_owned())));
        match created {
            Ok(t) => write_json(&Created {
                id: t.id,
                name: t.name,
            }),
            // 상한 초과는 429 다 (04-secops P1-4) — 문구에 할 일이 있다.
            Err(ToolError::ToolCap(m)) => fail(StatusCode::TOO_MANY_REQUESTS, &m, None),
            // 그 밖의 실패 문구에는 절대경로가 실린다 — 로그에만 남긴다.
            Err(e) => fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                "도구를 만들지 못했습니다",
                Some(&e),
            ),
        }
    }

    /// 새 도구에 얹을 환경이다. 설정 저장소가 없으면 빈 blob 의 값이다 (FR-ARE-3).
    fn render_env(&self) -> Vec<String> {
        match self.deps.settings.as_ref() {
            Some(s) => s.render_env(),
            None => crate::agent_render_env::agent_render_env(&[]),
        }
    }

    /// GET /api/tools/{id}/busy.
    pub(crate) async fn api_tool_busy(&self, r: &mut Req) -> Response {
        let id = r.path.strip_prefix("/api/tools/").unwrap_or(&r.path);
        let id = id.strip_suffix("/busy").unwrap_or(id).to_owned();
        let mut busy = false;
        if let Some(hub) = self.tools(Some(r)) {
            busy = off_thread(move || hub.busy(&id)).await.unwrap_or(false);
        }
        write_json(&Busy { busy })
    }

    /// GET /api/tools/busy?ids=a,b,c — `{busy:{id:bool}}` (FR-OPT-2-4). 데몬이 답하지 못하면
    /// 503 이다 — 모르는 것을 "바쁘지 않음" 으로 내지 않는다 (IPC-M2).
    pub(crate) async fn api_tools_busy(&self, r: &mut Req) -> Response {
        let ids: Vec<String> = r
            .q("ids")
            .split(',')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if ids.len() > MAX_BUSY_IDS {
            return fail(
                StatusCode::BAD_REQUEST,
                &format!("ids 는 {MAX_BUSY_IDS}개까지입니다"),
                None,
            );
        }
        let mut busy = BTreeMap::new();
        if let Some(hub) = self.tools(Some(r))
            && !ids.is_empty()
        {
            let Some(got) = off_thread(move || hub.busy_many(&ids)).await.flatten() else {
                return fail(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "도구 상태를 알 수 없습니다",
                    None,
                );
            };
            busy.extend(got);
        }
        write_json(&BusyMany { busy })
    }

    /// DELETE /api/tools/{id}.
    pub(crate) async fn api_tool_delete(&self, r: &mut Req) -> Response {
        let id = r
            .path
            .strip_prefix("/api/tools/")
            .unwrap_or(&r.path)
            .to_owned();
        if let Some(hub) = self.tools(Some(r)) {
            let id = id.clone();
            // `GO-8`: 이 경로에서 "이미 없다" 는 정상이다 — 오류를 명시로 무시한다.
            let _ = off_thread(move || hub.delete(&id)).await;
        }
        // FR-ATL-5: 이미 죽어 있던 도구를 지우는 경로에는 OnExit 가 오지 않는다.
        self.attention().forget(&id);
        empty(StatusCode::OK)
    }

    /// POST /api/tools/kill (FR-BGK-6). 응답은 종료가 끝난 뒤에 나간다.
    pub(crate) async fn api_tool_kill(&self, r: &mut Req) -> Response {
        let body = match read_body_http::<KillBody>(r).await {
            BodyRead::Answered(res) => return res,
            BodyRead::NotJson => None,
            BodyRead::Ok(b) => Some(b),
        };
        let Some(body) = body.filter(|b| !b.tool_id.is_empty()) else {
            return http_err(
                "toolId 필요",
                StatusCode::BAD_REQUEST,
                apierr::CODE_MISSING_ARG,
            );
        };
        let not_found = || {
            http_err(
                &format!("toolId={} 존재하지 않음", body.tool_id),
                StatusCode::NOT_FOUND,
                apierr::CODE_TOOL_NOT_FOUND,
            )
        };
        let Some(hub) = self.tools(Some(r)) else {
            return not_found();
        };
        // 유예는 도구가 있는 프로세스(데몬)에서 기다린다 (FBE-05/12).
        let id = body.tool_id.clone();
        let done = off_thread(move || hub.terminate(&id, TOOL_KILL_GRACE)).await;
        if !matches!(done, Some(Ok(()))) {
            return not_found();
        }
        write_json(&OkTrue { ok: true })
    }

    /// GET /api/workspace.
    pub(crate) async fn api_workspace_get(&self, _r: &mut Req) -> Response {
        let (raw, rev) = self.work_snapshot();
        let body = if raw.is_empty() {
            b"null".to_vec()
        } else {
            raw
        };
        let mut res = Response::new(httpresp::full(body));
        res = with_header(res, "ETag", &rev.to_string());
        with_header(res, "Content-Type", "application/json")
    }

    /// PUT /api/workspace. `If-Match` 를 요구한다 (FR-SFD-20·21).
    pub(crate) async fn api_workspace_put(&self, r: &mut Req) -> Response {
        let Some(work) = self.deps.work.clone() else {
            return http_err(
                "workspace unavailable",
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_WORK_UNREADY,
            );
        };
        // 워크스페이스는 창·탭·핀이 쌓이면 커진다 — 기본 상한보다 넉넉히 준다.
        let body = match r.read_body(httpreq::WORKSPACE_LIMIT).await {
            Ok(b) => b,
            Err(e) => return read_body_err(&e),
        };
        // 428: 조건을 아예 보내지 않았다 — 재조회부터 다시 한다 (D-3).
        let if_match = r.header("If-Match");
        if if_match.is_empty() {
            return with_header(
                http_err(
                    "If-Match required",
                    StatusCode::PRECONDITION_REQUIRED,
                    apierr::CODE_IF_MATCH_REQUIRED,
                ),
                "ETag",
                &work.current_rev().to_string(),
            );
        }
        let w = work.clone();
        let im = if_match.clone();
        let saved = off_thread(move || w.save(&body, &im)).await;
        let rev = match saved {
            Some(Ok(rev)) => rev,
            Some(Err(WorkspaceError::Stale)) => {
                return with_header(
                    http_err(
                        "stale revision",
                        StatusCode::CONFLICT,
                        apierr::CODE_STALE_REV,
                    ),
                    "ETag",
                    &work.current_rev().to_string(),
                );
            }
            // `workspace parse: …` — 사용자가 방금 보낸 본문에 대한 말이다.
            Some(Err(e)) => return fail(StatusCode::BAD_REQUEST, &e.to_string(), None),
            None => return fail(StatusCode::INTERNAL_SERVER_ERROR, "save cancelled", None),
        };
        // FR-SBX-8/9: Window 가 사라지면 대응 컨테이너도 사라져야 한다.
        self.reap_sandboxes().await;
        // FR-OPT-5-1: 같은 바이트면 rev 가 그대로다 — 다른 브라우저에 재조회를 시키지 않는다.
        let rev_s = rev.to_string();
        if rev_s != if_match {
            self.refresh_state_topic("workspace");
        }
        with_header(empty(StatusCode::OK), "ETag", &rev_s)
    }
}
