//! 에이전트 기록의 거울과 데몬 보고 (Go `agent_records.go`·`report_apply.go`).
//!
//! 서버의 저장소는 데몬 기록의 거울이다 (D-ARD-1, FR-ARD-11·13). 쓰기는 거울과 데몬에 함께 가고,
//! 스냅샷은 거울을 통째로 바꾼다.

use std::collections::{BTreeMap, HashMap, HashSet};

use dm_gocompat::json::{self, RawMessage};
use dm_shared_agentrec::{self as agentrec, SubagentActivity};
use dm_shared_dmlog::warnf;
use dm_shared_toolhub::AgentState;
use dm_shared_toolipc::{self as toolipc, RecordsResult};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::Server;
use crate::subagents::SubagentList;
use crate::usage::{ToolUsage, from_unix_milli, lock};

/// Go `RecordSink`: 기록을 데몬에 쓰는 큐다 (recordsync.Writer). `v` 가 `None` 이면 지운다.
/// `v` 는 기록 값의 JSON 이다.
pub trait RecordSink: Send + Sync {
    fn put(&self, kind: &str, tool: &str, v: Option<Vec<u8>>);
}

fn decode_record<T: DeserializeOwned>(kind: &str, tool: &str, raw: &RawMessage) -> Option<T> {
    match json::unmarshal(&raw.0) {
        Ok(v) => Some(v),
        Err(e) => {
            warnf!(None, "records: {kind}/{tool} 를 읽지 못했다: {e}");
            None
        }
    }
}

impl Server {
    pub(crate) fn put_record<T: Serialize + ?Sized>(&self, kind: &str, tool: &str, v: Option<&T>) {
        if let Some(sink) = &self.deps.records {
            sink.put(kind, tool, v.map(|v| json::marshal(v).unwrap_or_default()));
        }
    }

    /// Go `ApplyRecords`: 스냅샷으로 거울을 통째로 바꾼다 (FR-ARD-13). 알람은 울리지 않는다.
    pub fn apply_records(&self, res: &RecordsResult) {
        let tools = res.tools.as_deref().unwrap_or_default();
        let mut agents: HashMap<String, AgentState> = HashMap::with_capacity(tools.len());
        let mut usage: HashMap<String, ToolUsage> = HashMap::new();
        let mut subs: HashMap<String, SubagentList> = HashMap::new();
        let mut acts: HashMap<String, BTreeMap<String, SubagentActivity>> = HashMap::new();
        let mut told: HashSet<String> = HashSet::new();
        for tr in tools {
            agents.insert(tr.tool.clone(), tr.agent.clone());
            for (kind, raw) in &tr.records {
                match kind.as_str() {
                    toolipc::RECORD_USAGE => {
                        if let Some(u) = decode_record::<ToolUsage>(kind, &tr.tool, raw) {
                            usage.insert(tr.tool.clone(), u);
                        }
                    }
                    toolipc::RECORD_SUBAGENTS => {
                        if let Some(r) =
                            decode_record::<agentrec::SubagentList>(kind, &tr.tool, raw)
                        {
                            subs.insert(
                                tr.tool.clone(),
                                SubagentList {
                                    tasks: r.tasks,
                                    observed_at: from_unix_milli(r.observed_at),
                                },
                            );
                        }
                    }
                    toolipc::RECORD_SUBAGENT_ACTS => {
                        if let Some(Some(m)) = decode_record::<
                            Option<BTreeMap<String, SubagentActivity>>,
                        >(kind, &tr.tool, raw)
                            && !m.is_empty()
                        {
                            acts.insert(tr.tool.clone(), m);
                        }
                    }
                    toolipc::RECORD_MIGRATION_TOLD => {
                        told.insert(tr.tool.clone());
                    }
                    _ => {}
                }
            }
        }
        let limits = res
            .global
            .get(toolipc::RECORD_LIMITS)
            .and_then(|raw| {
                decode_record::<Option<BTreeMap<String, agentrec::LimitRecord>>>(
                    toolipc::RECORD_LIMITS,
                    "",
                    raw,
                )
            })
            .flatten()
            .unwrap_or_default();

        *lock(&self.agents.usage.m) = usage;
        *lock(&self.agents.subagents.m) = subs;
        *lock(&self.agents.sub_acts.m) = acts;
        *lock(&self.agents.migration_unknown_told) = told;
        self.agents.rate_limits.replace(limits);
        if let Some(t) = &self.deps.attn_tracker {
            t.restore_all(&agents);
        }
        self.activity_changed.notify();
    }

    /// Go `ApplyReport`: 데몬이 넘긴 보고 하나다 (§3.2a). HTTP 처리기와 같은 함수를 지난다.
    pub fn apply_report(&self, method: &str, body: &[u8]) {
        let err = match method {
            agentrec::METHOD_ACTIVITY => {
                json::unmarshal::<agentrec::ActivityReport>(body).map(|r| {
                    if let Some(code) = self.apply_activity_report(&r) {
                        warnf!(None, "report: 활동 보고를 받지 않았다({code})");
                    }
                })
            }
            agentrec::METHOD_USAGE => json::unmarshal::<agentrec::UsageReport>(body).map(|r| {
                if !r.tool_id.is_empty() {
                    self.apply_usage_report(&r);
                }
            }),
            agentrec::METHOD_SUBAGENTS => {
                json::unmarshal::<agentrec::SubagentsReport>(body).map(|r| {
                    if !r.tool_id.is_empty() {
                        self.apply_subagents_report(&r);
                    }
                })
            }
            agentrec::METHOD_NOTIFY => json::unmarshal::<agentrec::NotifyReport>(body).map(|r| {
                if !r.tool_id.is_empty() {
                    self.apply_notify_report(&r);
                }
            }),
            _ => {
                warnf!(
                    None,
                    "report: 모르는 보고 {}",
                    dm_gocompat::strconv::quote(method)
                );
                Ok(())
            }
        };
        if let Err(e) = err {
            warnf!(None, "report: {method} 를 읽지 못했다: {e}");
        }
    }
}
