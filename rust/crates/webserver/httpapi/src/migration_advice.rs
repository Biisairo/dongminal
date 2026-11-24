//! 맥락 기준 migration 의 설정과 일반 훅의 판정 (Go `handlers_migration_advice.go`, ISSUE_TREE_OPS_SRS
//! 묶음 M).

use std::collections::HashMap;
use std::sync::LazyLock;

use otter_gocompat::json;
use otter_shared_httpresp::Response;
use otter_shared_settingsschema::{self as settingsschema, Spec};
use otter_shared_toolipc as toolipc;
use serde::Serialize;
use serde_json::Value;

use crate::Server;
use crate::httperr::write_json;
use crate::req::Req;
use crate::usage::lock;

/// 설정 넷이다 (FR-ITM-1). 일반 훅과 issue-tree 는 서로 영향을 주지 않는다 (FR-ITM-2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MigrationConf {
    pub hook_on: bool,
    pub hook_pct: i64,
    pub tree_on: bool,
    pub tree_pct: i64,
}

const MIGRATION_HOOK_KEY: &str = "migrationHook";
const MIGRATION_HOOK_PCT_KEY: &str = "migrationHookCtxPct";
const ISSUE_TREE_ON_KEY: &str = "issueTreeMigration";
const ISSUE_TREE_PCT_KEY: &str = "issueTreeCtxPct";

const MIGRATION_HOOK_FALLBACK: bool = false;
const ISSUE_TREE_ON_FALLBACK: bool = true;
/// 표를 읽지 못했을 때의 기준이다 (Go `issueTreeCtxDefault`).
const MIGRATION_PCT_FALLBACK: i64 = 50;

/// 서술자 표의 넷이다. 기본값·범위를 여기 적지 않는다 — 표가 단일 원천이다 (FR-CFG-10).
static MIGRATION_SPECS: LazyLock<HashMap<String, Spec>> = LazyLock::new(|| {
    settingsschema::load()
        .map(|specs| settingsschema::by_key(&specs))
        .unwrap_or_default()
});

/// Go `parseMigrationConf`: blob 에서 넷을 읽는다. 비었거나 타입·범위 밖이면 표의 기본값이다
/// (FR-ITM-4). 표를 읽지 못하면 일반 훅은 끔, issue-tree 는 켬, 기준은 50 이다.
pub fn parse_migration_conf(blob: &[u8]) -> MigrationConf {
    let m: Option<serde_json::Map<String, Value>> = json::unmarshal(blob).ok().flatten();
    let specs = &*MIGRATION_SPECS;
    let spec = |k: &str| specs.get(k);
    MigrationConf {
        hook_on: setting_bool(
            m.as_ref(),
            spec(MIGRATION_HOOK_KEY),
            MIGRATION_HOOK_FALLBACK,
        ),
        hook_pct: setting_int(m.as_ref(), spec(MIGRATION_HOOK_PCT_KEY)),
        tree_on: setting_bool(m.as_ref(), spec(ISSUE_TREE_ON_KEY), ISSUE_TREE_ON_FALLBACK),
        tree_pct: setting_int(m.as_ref(), spec(ISSUE_TREE_PCT_KEY)),
    }
}

fn setting_bool(
    m: Option<&serde_json::Map<String, Value>>,
    spec: Option<&Spec>,
    fallback: bool,
) -> bool {
    let def = spec.and_then(|s| s.def.as_bool()).unwrap_or(fallback);
    let key = spec.map_or("", |s| s.key.as_str());
    match m.and_then(|m| m.get(key)) {
        Some(Value::Bool(v)) if !key.is_empty() => *v,
        _ => def,
    }
}

fn setting_int(m: Option<&serde_json::Map<String, Value>>, spec: Option<&Spec>) -> i64 {
    let n = spec
        .and_then(|s| s.def.as_f64())
        .map_or(MIGRATION_PCT_FALLBACK, |d| d as i64);
    let Some(spec) = spec.filter(|s| !s.key.is_empty()) else {
        return n;
    };
    if let Some(v) = m.and_then(|m| m.get(&spec.key)).and_then(Value::as_f64) {
        let i = v as i64;
        if i as f64 == v
            && spec.min.is_none_or(|min| i >= min)
            && spec.max.is_none_or(|max| i <= max)
        {
            return i;
        }
    }
    n
}

// 판정 (FR-ITM-11).
const ADVICE_SKIP: &str = "skip";
const ADVICE_UNKNOWN: &str = "unknown";
const ADVICE_ADVISE: &str = "advise";
const ADVICE_MUST: &str = "must";
const ADVICE_OK: &str = "ok";

/// 맥락 판단은 기준의 4/5 에서 시작하고, 상한은 판단 없이 넘기는 자리다 (FR-ITM-16·23).
const MIGRATION_JUDGE_NUM: i64 = 4;
const MIGRATION_JUDGE_DEN: i64 = 5;
const MIGRATION_CAP_PCT: i64 = 85;

/// Go `judgePct`: 기준 pct 의 판단 시작점이다 (FR-ITM-23).
pub(crate) fn judge_pct(pct: i64) -> f64 {
    (pct * MIGRATION_JUDGE_NUM) as f64 / MIGRATION_JUDGE_DEN as f64
}

/// Go 의 `map[string]any` 응답이다 — 키 이름 순으로 둔다.
#[derive(Serialize)]
struct Advice {
    #[serde(rename = "capPct")]
    cap_pct: i64,
    #[serde(rename = "ctxPct")]
    ctx_pct: i64,
    #[serde(rename = "judgePct")]
    judge_pct: f64,
    #[serde(rename = "usedPct", skip_serializing_if = "Option::is_none")]
    used_pct: Option<f64>,
    verdict: &'static str,
}

impl Server {
    /// Go `migrationConf`: 지금 설정이다. 설정 저장소가 없으면 기본값이다.
    pub(crate) fn migration_conf(&self) -> MigrationConf {
        match &self.deps.settings {
            Some(s) => s.migration(),
            None => parse_migration_conf(b""),
        }
    }

    /// GET /api/tools/migration-advice?id=<toolId> (FR-ITM-10·11).
    pub(crate) async fn api_migration_advice(&self, r: &mut Req) -> Response {
        let id = r.q("id").trim().to_owned();
        let conf = self.migration_conf();
        let mut out = Advice {
            cap_pct: MIGRATION_CAP_PCT,
            ctx_pct: conf.hook_pct,
            judge_pct: judge_pct(conf.hook_pct),
            used_pct: None,
            verdict: ADVICE_OK,
        };
        out.verdict = self.migration_verdict(&id, conf, &mut out.used_pct);
        write_json(&out)
    }

    /// 트리 노드(Run 멤버의 assign)는 자기 절차를 따른다 (D-ITO-5).
    fn migration_verdict(
        &self,
        id: &str,
        conf: MigrationConf,
        used: &mut Option<f64>,
    ) -> &'static str {
        if self
            .runs()
            .and_then(|st| st.member_by_tool(id))
            .is_some_and(|m| m.assign.is_some())
        {
            return ADVICE_SKIP;
        }
        if !conf.hook_on {
            return ADVICE_SKIP;
        }
        let pct = self.tool_usage_view(id).0.and_then(|c| c.used_pct);
        let Some(pct) = pct else {
            // FR-ITM-13: 모르는 사실은 도구마다 한 번만 알린다.
            if !lock(&self.agents.migration_unknown_told).insert(id.to_owned()) {
                return ADVICE_OK;
            }
            self.put_record(toolipc::RECORD_MIGRATION_TOLD, id, Some(&true));
            return ADVICE_UNKNOWN;
        };
        *used = Some(pct);
        if pct >= MIGRATION_CAP_PCT as f64 {
            ADVICE_MUST
        } else if pct >= judge_pct(conf.hook_pct) {
            ADVICE_ADVISE
        } else {
            ADVICE_OK
        }
    }
}
