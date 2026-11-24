//! Run 표식(`tab.runId`·`window.ownerRunId`)과 도구→탭 조회 (Go `handlers_runs_marks.go`,
//! FR-EM-17).

use std::collections::HashSet;

use otter_gocompat::json;
use otter_shared_otterlog::{errorf, infof};
use otter_shared_workspace::apply_run_marks;
use otter_webserver_domain_run::{self as run, Record};
use serde_json::{Map, Value};

use crate::Server;

/// 동시 편집으로 stale 이 났을 때 다시 해 보는 횟수다.
const MARK_ATTEMPTS: usize = 3;

impl Server {
    /// Go `tabIDOfTool`: 도구가 앉은 탭의 uuid. 없으면 빈다.
    pub(crate) fn tab_id_of_tool(&self, tool_id: &str) -> String {
        let Some(idx) = &self.deps.work_index else {
            return String::new();
        };
        idx.entries()
            .into_iter()
            .find(|e| e.tool_id == tool_id)
            .map(|e| e.tab_uuid)
            .unwrap_or_default()
    }

    /// Go `markWorkspaceRun`: `run_id` 가 비면 표식을 지운다.
    pub(crate) fn mark_workspace_run(&self, rec: &Record, tab_id: &str, run_id: &str) {
        self.mark_workspace_run_except(rec, tab_id, run_id, &HashSet::new());
    }

    /// Go `markWorkspaceRunExcept`: `skip` 의 탭은 건드리지 않는다 — 닫힌 탭의 표식을 쓰려고
    /// rev 를 올리지 않는다.
    pub(crate) fn mark_workspace_run_except(
        &self,
        rec: &Record,
        tab_id: &str,
        run_id: &str,
        skip: &HashSet<String>,
    ) {
        let Some(work) = self.work() else {
            return;
        };
        let mut tabs = HashSet::new();
        if !tab_id.is_empty() {
            if !skip.contains(tab_id) {
                tabs.insert(tab_id.to_owned());
            }
        } else {
            for m in &rec.members {
                if !m.tab_id.is_empty() && !skip.contains(&m.tab_id) {
                    tabs.insert(m.tab_id.clone());
                }
            }
        }
        let mut window_id = rec.window_id.as_str();
        if !skip.is_empty() && tabs.is_empty() {
            window_id = ""; // 창이 사라진다 — 그 표식을 쓰려고 rev 를 올리지 않는다
        }
        let mark_window = rec.projection == run::DEDICATED_WINDOW && !window_id.is_empty();

        for _ in 0..MARK_ATTEMPTS {
            let (blob, rev) = work.snapshot();
            if blob.is_empty() {
                return;
            }
            let mut tree: Map<String, Value> =
                match json::unmarshal::<Option<Map<String, Value>>>(&blob) {
                    Ok(t) => t.unwrap_or_default(),
                    Err(e) => {
                        errorf!(None, "[run] workspace 표식 생략 — 파싱 실패: {e}");
                        return;
                    }
                };
            if !apply_run_marks(&mut tree, &tabs, window_id, mark_window, run_id) {
                return; // 바꿀 것이 없다
            }
            let out = match json::marshal(&tree) {
                Ok(b) => b,
                Err(e) => {
                    errorf!(None, "[run] workspace 표식 생략 — 직렬화 실패: {e}");
                    return;
                }
            };
            match work.save(&out, &rev.to_string()) {
                Ok(new_rev) => {
                    if let Some(c) = self.commands() {
                        c.broadcast(&otter_webserver_sse::workspace_changed(new_rev));
                    }
                    return;
                }
                Err(e) if e.is_stale() => {}
                Err(e) => {
                    errorf!(None, "[run] workspace 표식 실패: {e}");
                    return;
                }
            }
        }
        infof!(
            None,
            "[run] workspace 표식 포기 — 동시 편집으로 3회 stale (runId={run_id})"
        );
    }
}
