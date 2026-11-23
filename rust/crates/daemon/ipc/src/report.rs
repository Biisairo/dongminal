//! 보고 소켓 — 에이전트 훅의 보고를 받아 도구 상태에 반영하고 서버에 report push 로 넘긴다
//! (AGENT_RECORD_DAEMON_SRS §3.2a). 같은 소켓이 데몬 교체 제어(daemon.hello·daemon.reload)도 받는다.

use std::collections::BTreeMap;
use std::io::{self, BufRead, BufReader, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use dm_gocompat::json::{self, RawMessage};
use dm_shared_activity as activity;
use dm_shared_agentrec as agentrec;
use dm_shared_dmlog::warnf;
use dm_shared_handover as handover;
use dm_shared_platform::IpcStream;
use dm_shared_toolhub::{ManagerError, Tool};
use dm_shared_toolipc as ipc;
use serde::Serialize;
use time::OffsetDateTime;

use crate::conn::{Conn, lock};
use crate::server::{Inner, PanedServer};

/// 교체 제어 연결의 시한이다 — 새 바이너리의 사전 점검(5초)과 상태 준비를 담는다.
pub const RELOAD_WITHIN: Duration = Duration::from_secs(12);

pub const ERR_REPORT_OLD_SERVER: &str = "붙은 서버가 report push 를 모른다";
pub const ERR_REPORT_TOOL_ID: &str = "toolId 가 비었다";
pub const ERR_REPORT_STATE: &str = "활동 상태가 틀렸다";

/// 보고를 반영하지 못한 사정이다. not_found 면 IPC 코드가 CODE_NOT_FOUND 다.
pub(crate) struct ReportError {
    pub msg: String,
    pub not_found: bool,
}

impl ReportError {
    fn msg(m: impl Into<String>) -> Self {
        Self {
            msg: m.into(),
            not_found: false,
        }
    }
}

impl PanedServer {
    /// 보고 소켓을 연다.
    pub fn listen_reports(&self, path: &Path) -> io::Result<()> {
        let ipc_t = &dm_shared_platform::current().ipc;
        let _ = ipc_t.remove(path);
        if let Some(dir) = path.parent() {
            let mut b = std::fs::DirBuilder::new();
            b.recursive(true);
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
            b.create(dir)?;
        }
        let ln = ipc_t.listen(path)?;
        let mut l = lock(&self.inner.listeners);
        l.report = Some(Arc::new(ln));
        l.report_path = path.to_path_buf();
        Ok(())
    }

    /// 보고 연결을 받는다(블로킹). 연결마다 스레드 하나다. 소켓이 닫히면 돌아온다.
    pub fn serve_reports(&self) {
        let Some(ln) = lock(&self.inner.listeners).report.clone() else {
            return;
        };
        loop {
            let Ok(c) = ln.accept() else { return };
            if self.inner.closed.load(Ordering::SeqCst) {
                return;
            }
            let s = self.clone();
            thread::spawn(move || s.serve_report(&c));
        }
    }

    fn serve_report(&self, c: &IpcStream) {
        let _ = c.set_read_timeout(Some(agentrec::IO_TIMEOUT));
        let _ = c.set_write_timeout(Some(agentrec::IO_TIMEOUT));
        let mut line = Vec::new();
        if BufReader::new(c).read_until(b'\n', &mut line).is_err() {
            return;
        }
        let Ok(rq) = json::Decoder::new().decode::<agentrec::Request>(&line) else {
            return;
        };
        if is_control(&rq.method) {
            let _ = c.set_read_timeout(Some(RELOAD_WITHIN));
            let _ = c.set_write_timeout(Some(RELOAD_WITHIN));
            let (reply, commit) = self.handle_control(&rq);
            if let Err(e) = write_line(c, &reply) {
                warnf!(None, "control: 응답을 쓰지 못했다: {e}");
            }
            let _ = c.shutdown(std::net::Shutdown::Both);
            if let Some(f) = commit {
                f();
            }
            return;
        }
        if let Err(e) = write_line(c, &self.handle_report(&rq)) {
            warnf!(None, "report: 응답을 쓰지 못했다: {e}");
        }
    }

    pub(crate) fn handle_report(&self, rq: &agentrec::Request) -> agentrec::Reply {
        if rq.method == handover::METHOD_HELLO {
            return self.handle_control(rq).0;
        }
        if !agentrec::known_method(&rq.method) {
            return reply_err(format!(
                "{}: {}",
                handover::OLD_DAEMON_UNKNOWN_METHOD,
                rq.method
            ));
        }
        let c = lock(&self.inner.curr).clone();
        if let Some(c) = &c
            && !c.reports.load(Ordering::SeqCst)
        {
            return reply_err(ERR_REPORT_OLD_SERVER.to_owned());
        }
        match self.inner.accept_report(c.as_ref(), &rq.method, &rq.body) {
            Ok(()) => agentrec::Reply {
                ok: true,
                error: String::new(),
            },
            Err(e) => reply_err(e.msg),
        }
    }

    pub(crate) fn handle_control(
        &self,
        rq: &agentrec::Request,
    ) -> (agentrec::Reply, Option<Box<dyn FnOnce() + Send>>) {
        let ok = agentrec::Reply {
            ok: true,
            error: String::new(),
        };
        if rq.method == handover::METHOD_HELLO {
            return (ok, None);
        }
        if rq.body.0.len() > handover::MAX_REQUEST_BYTES {
            return (
                reply_err(format!("{}: 요청이 너무 큽니다", handover::REASON_EXE)),
                None,
            );
        }
        let Some(f) = lock(&self.inner.reloader).clone() else {
            return (
                reply_err(format!(
                    "{}: 이 데몬은 세션 유지 교체를 하지 않습니다",
                    handover::REASON_UNSUPPORTED
                )),
                None,
            );
        };
        let Ok(req) = json::unmarshal::<handover::ReloadRequest>(&rq.body.0) else {
            return (
                reply_err(format!("{}: 요청을 읽지 못했습니다", handover::REASON_EXE)),
                None,
            );
        };
        match f(req) {
            Ok(commit) => (ok, Some(commit)),
            Err(e) => (reply_err(e), None),
        }
    }
}

fn is_control(m: &str) -> bool {
    m == handover::METHOD_HELLO || m == handover::METHOD_RELOAD
}

fn reply_err(error: String) -> agentrec::Reply {
    agentrec::Reply { ok: false, error }
}

fn write_line<T: Serialize>(mut c: &IpcStream, v: &T) -> io::Result<()> {
    let b = json::Encoder::new()
        .encode(v)
        .map_err(|e| io::Error::other(e.to_string()))?;
    c.write_all(&b)
}

fn unix_milli(t: OffsetDateTime) -> i64 {
    i64::try_from(t.unix_timestamp_nanos() / 1_000_000).unwrap_or(i64::MAX)
}

fn set_record_json<T: Serialize>(p: &Tool, kind: &str, v: &T) {
    match json::marshal(v) {
        Ok(raw) => p.set_record(kind, &raw),
        Err(e) => warnf!(None, "report: {kind} 를 쓰지 못했다: {e}"),
    }
}

impl Inner {
    /// 보고를 반영하고, 성공하면 서버 연결에 report push 로 넘긴다.
    pub(crate) fn accept_report(
        &self,
        c: Option<&Arc<Conn>>,
        method: &str,
        body: &RawMessage,
    ) -> Result<(), ReportError> {
        {
            let _g = lock(&self.report_mu);
            self.apply_report(method, body, OffsetDateTime::now_utc())?;
        }
        if let Some(c) = c {
            c.enqueue(
                &ipc::ReportEvent {
                    event: ipc::EVENT_REPORT.into(),
                    method: method.into(),
                    body: body.clone(),
                },
                false,
            );
        }
        Ok(())
    }

    fn report_tool<T: serde::de::DeserializeOwned>(
        &self,
        body: &RawMessage,
        id: impl FnOnce(&T) -> String,
    ) -> Result<(T, Arc<Tool>), ReportError> {
        let v: T = json::unmarshal(&body.0).map_err(|e| ReportError::msg(e.to_string()))?;
        let tool_id = id(&v);
        if tool_id.is_empty() {
            return Err(ReportError::msg(ERR_REPORT_TOOL_ID));
        }
        let p = self.pm.get(&tool_id).ok_or(ReportError {
            msg: ManagerError::NotFound.to_string(),
            not_found: true,
        })?;
        Ok((v, p))
    }

    fn apply_report(
        &self,
        method: &str,
        body: &RawMessage,
        now: OffsetDateTime,
    ) -> Result<(), ReportError> {
        match method {
            agentrec::METHOD_ACTIVITY => {
                let (r, p) =
                    self.report_tool(body, |r: &agentrec::ActivityReport| r.tool_id.clone())?;
                apply_activity_report(&p, &r, now)
            }
            agentrec::METHOD_USAGE => {
                let (r, p) =
                    self.report_tool(body, |r: &agentrec::UsageReport| r.tool_id.clone())?;
                set_record_json(
                    &p,
                    ipc::RECORD_USAGE,
                    &agentrec::Usage {
                        usage: r.usage.clone(),
                        observed_at: unix_milli(now),
                    },
                );
                let windows = r.usage.rate_limits.clone().unwrap_or_default();
                if let Some(agent) = dm_shared_agentadapter::status_line_reporter()
                    && r.account.is_none()
                    && !windows.is_empty()
                {
                    self.records.update(ipc::RECORD_LIMITS, |old| {
                        let mut m: BTreeMap<String, agentrec::LimitRecord> = old
                            .and_then(|o| json::unmarshal(&o.0).ok())
                            .unwrap_or_default();
                        agentrec::merge_limits(&mut m, agent, &windows, now);
                        m
                    });
                }
                Ok(())
            }
            agentrec::METHOD_SUBAGENTS => {
                let (r, p) =
                    self.report_tool(body, |r: &agentrec::SubagentsReport| r.tool_id.clone())?;
                set_record_json(
                    &p,
                    ipc::RECORD_SUBAGENTS,
                    &agentrec::SubagentList {
                        tasks: r.tasks,
                        observed_at: unix_milli(now),
                    },
                );
                Ok(())
            }
            agentrec::METHOD_NOTIFY => {
                let (r, p) =
                    self.report_tool(body, |r: &agentrec::NotifyReport| r.tool_id.clone())?;
                p.signal_attention(agentrec::notify_reason(&r.reason));
                Ok(())
            }
            _ => Ok(()),
        }
    }
}

fn apply_activity_report(
    p: &Tool,
    r: &agentrec::ActivityReport,
    now: OffsetDateTime,
) -> Result<(), ReportError> {
    if !activity::valid(&r.state) {
        return Err(ReportError::msg(ERR_REPORT_STATE));
    }
    if !r.agent_id.is_empty() {
        if !agentrec::valid_subagent_state(&r.state) {
            return Err(ReportError::msg(ERR_REPORT_STATE));
        }
        let mut acts: BTreeMap<String, agentrec::SubagentActivity> = p
            .records()
            .get(ipc::RECORD_SUBAGENT_ACTS)
            .and_then(|o| json::unmarshal(&o.0).ok())
            .unwrap_or_default();
        agentrec::put_subagent_activity(
            &mut acts,
            &r.agent_id,
            agentrec::subagent_activity_of(r),
            now,
        );
        set_record_json(p, ipc::RECORD_SUBAGENT_ACTS, &acts);
        return Ok(());
    }
    p.report_activity(
        &r.state,
        &agentrec::sanitize(&r.tool, agentrec::TOOL_MAX),
        &agentrec::sanitize(&r.detail, agentrec::DETAIL_MAX),
        agentrec::agent_reports_turn_start(&r.agent),
    );
    if r.state == activity::ENDED {
        p.set_record(ipc::RECORD_SUBAGENT_ACTS, &[]);
    }
    Ok(())
}
