//! `toolhub.ToolHub` 계약의 구현이다 — 목록·생성·삭제·입출력·스냅샷.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::{Duration, Instant};

use dm_gocompat::json;
use dm_shared_toolhub::{BackgroundEntry, ExitInfo, Placement, ShellState, ToolInfo, ToolSnapshot};
use dm_shared_toolipc::{
    BackgroundListResult, BusyManyParams, BusyManyResult, BusyResult, CODE_NOT_FOUND,
    CODE_TOOL_CAP, CreateParams, CreateResult, CwdResult, FEATURE_BUSY_MANY, FEATURE_NOTIFY,
    FEATURE_SHELL_PROBE, IdParams, METHOD_BACKGROUND_LIST, METHOD_BUSY, METHOD_BUSY_MANY,
    METHOD_CREATE, METHOD_CWD, METHOD_INPUT, METHOD_KILL, METHOD_LIST, METHOD_PASTE, METHOD_RESIZE,
    METHOD_RESIZE_NOTIFY, METHOD_RESTORE, METHOD_SET_BACKGROUND, METHOD_SHELL_PROBE,
    METHOD_SNAPSHOT, METHOD_TERMINATE, METHOD_WRITE, PasteParams, ResizeParams, RestoreParams,
    SetBackgroundParams, SetBackgroundResult, ShellProbeParams, ShellProbeResult, SnapshotParams,
    SnapshotResult, TerminateParams, WriteParams,
};

use crate::client::{Inner, TOOL_CALL_TIMEOUT, TOOL_CREATE_TIMEOUT, ToolClient, lock, result_key};
use crate::error::Error;
use crate::wire::Empty;

/// 목록 캐시의 수명이다. 그 안의 변경은 push 와 변경 호출이 무효화로 덮는다 (M8 `GO-6`).
pub const LIST_CACHE_TTL: Duration = Duration::from_millis(200);

/// 데몬 모드의 도구 신원이다 (Go `Get` 이 주는 합성 Tool 의 ID·Name, `GO-47`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ToolIdentity {
    pub id: String,
    pub name: String,
}

#[derive(Default)]
pub(crate) struct ListState {
    pub cache: Vec<ToolInfo>,
    pub at: Option<Instant>,
    pub generation: u64,
}

impl Inner {
    fn cached_list(&self) -> Option<Vec<ToolInfo>> {
        let l = lock(&self.list);
        match l.at {
            Some(at) if at.elapsed() <= LIST_CACHE_TTL => Some(l.cache.clone()),
            _ => None,
        }
    }

    pub(crate) fn list_generation(&self) -> u64 {
        lock(&self.list).generation
    }

    /// 그 사이 무효화가 없었을 때만 저장한다 — 있었으면 이 응답은 낡은 것이다.
    pub(crate) fn store_list(&self, tools: Vec<ToolInfo>, generation: u64) {
        let mut l = lock(&self.list);
        if l.generation == generation {
            l.cache = tools;
            l.at = Some(Instant::now());
        }
    }

    /// 캐시를 버리고 세대를 올린다. 진행 중인 list 응답은 저장되지 않는다.
    pub(crate) fn invalidate_list(&self) {
        let mut l = lock(&self.list);
        l.at = None;
        l.generation += 1;
    }

    /// 목록과 함께 그 목록이 관측된 사실인지다 (FR-TLU-2). `None` 은 모르는 것이다.
    pub(crate) fn list_ok(&self) -> Option<Vec<ToolInfo>> {
        if let Some(tools) = self.cached_list() {
            return Some(tools);
        }
        let generation = self.list_generation();
        let raw = self
            .call_raw(METHOD_LIST, &Empty {}, TOOL_CALL_TIMEOUT)
            .ok()?;
        // 키가 없는 것은 목록이 아니다. null 은 도구 0개이며 아는 것이다.
        let tools = result_key(&raw, "tools")?;
        let out: Option<Vec<ToolInfo>> = json::unmarshal(&tools.0).ok()?;
        let out = out.unwrap_or_default();
        self.store_list(out.clone(), generation);
        Some(out)
    }

    /// 재접속 뒤 끊긴 동안 놓친 exit·출력·전경 이름을 메운다 (FR-OPT-1-2·FR-OPT-2-1).
    pub(crate) fn resync_after_reconnect(&self) {
        let mut known: BTreeSet<String> = lock(&self.list)
            .cache
            .iter()
            .map(|t| t.id.clone())
            .collect();
        self.invalidate_list();
        let fg_from = lock(&self.fg).seq;
        let tools = self.list_ok();
        let alive: HashSet<String> = tools.iter().flatten().map(|t| t.id.clone()).collect();
        let ok = tools.is_some();
        known.extend(self.detach_subs(|id| ok && !alive.contains(id)));
        let Some(tools) = tools else {
            return;
        };
        self.resync_foreground(&tools, fg_from);
        let Some(cb) = lock(&self.st).cbs.on_exit.clone() else {
            return;
        };
        for id in known.iter().filter(|id| !alive.contains(*id)) {
            cb(id, ExitInfo::default());
        }
    }

    /// 끊긴 동안 바뀐 전경 이름을 알린다. fg_from 뒤에 push 로 온 도구는 그 값이 더 새것이다.
    fn resync_foreground(&self, tools: &[ToolInfo], fg_from: u64) {
        let cb = lock(&self.st).cbs.on_foreground.clone();
        let mut fg = lock(&self.fg);
        let mut seen = HashMap::with_capacity(tools.len());
        for t in tools {
            let mut e = fg.seen.get(&t.id).cloned().unwrap_or_default();
            if e.seq <= fg_from && e.name != t.fg_name {
                e.name.clone_from(&t.fg_name);
                if let Some(cb) = &cb {
                    cb(&t.id, &t.fg_name);
                }
            }
            seen.insert(t.id.clone(), e);
        }
        fg.seen = seen;
    }
}

impl ToolClient {
    pub fn list(&self) -> Vec<ToolInfo> {
        self.list_ok().unwrap_or_default()
    }

    /// 목록과 함께 그 목록이 관측된 사실인지다 (TOOL_LIST_UNKNOWN_SRS FR-TLU-2). 응답이 왔으면
    /// 비어 있어도 `Some` 이고, 묻지 못했으면 `None` 이다. 200ms 캐시를 쓴다.
    pub fn list_ok(&self) -> Option<Vec<ToolInfo>> {
        self.inner.list_ok()
    }

    /// 도구를 띄운다. 샌드박스 배치는 데몬이 하므로 값만 실어 보낸다 (FR-SBX-11).
    pub fn create(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        place: &Placement,
    ) -> Result<ToolIdentity, Error> {
        self.inner.invalidate_list();
        let params = CreateParams {
            cols,
            command: place.command.clone(),
            cwd: cwd.to_owned(),
            // Go 의 nil 은 null 이다. toolhub Placement 는 nil 과 빈 slice 를 가르지 않으므로 빈 것을 nil 로 둔다.
            extra_env: Some(place.extra_env.clone()).filter(|e| !e.is_empty()),
            profile: place.profile.clone(),
            rows,
            window: place.window_uuid.clone(),
            work: place.work.clone(),
        };
        let resp: CreateResult = self
            .call_within(METHOD_CREATE, &params, TOOL_CREATE_TIMEOUT)
            .map_err(|e| match e {
                Error::Rpc(r) if r.code == CODE_TOOL_CAP => Error::ToolCap(r.message),
                e => e,
            })?;
        self.inner.invalidate_list();
        Ok(ToolIdentity {
            id: resp.id,
            name: resp.name,
        })
    }

    /// 목록에서 찾은 신원이다 (`GO-47`).
    pub fn get(&self, id: &str) -> Option<ToolIdentity> {
        self.list()
            .into_iter()
            .find(|t| t.id == id)
            .map(|t| ToolIdentity {
                id: id.to_owned(),
                name: t.name,
            })
    }

    pub fn is_live(&self, id: &str) -> bool {
        self.get(id).is_some()
    }

    /// 데몬에게 그 도구를 지우라 한다. RPC 의 실패를 그대로 돌려준다 (`GO-8`).
    pub fn delete(&self, id: &str) -> Result<(), Error> {
        self.inner.invalidate_list();
        let r = self.call_raw(METHOD_KILL, &IdParams { id: id.to_owned() });
        self.inner.invalidate_list();
        r.map(drop)
    }

    /// 데몬이 유예를 기다린 뒤 지우므로 시한은 기본 시한에 유예를 더한 값이다 (FBE-05/12).
    pub fn terminate(&self, id: &str, grace: Duration) -> Result<(), Error> {
        self.inner.invalidate_list();
        let params = TerminateParams {
            grace_ms: i64::try_from(grace.as_millis()).unwrap_or(i64::MAX),
            id: id.to_owned(),
        };
        let r = self
            .inner
            .call_raw(METHOD_TERMINATE, &params, TOOL_CALL_TIMEOUT + grace);
        self.inner.invalidate_list();
        r.map(drop)
    }

    pub fn restore(
        &self,
        id: &str,
        name: &str,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), Error> {
        self.inner.invalidate_list();
        let params = RestoreParams {
            cols,
            cwd: cwd.to_owned(),
            id: id.to_owned(),
            name: name.to_owned(),
            rows,
        };
        let r = self.call_raw(METHOD_RESTORE, &params);
        self.inner.invalidate_list();
        r.map(drop)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), Error> {
        let params = WriteParams {
            data: data.to_vec(),
            id: id.to_owned(),
        };
        self.call_raw(METHOD_WRITE, &params).map(drop)
    }

    /// 감싸기와 제출을 데몬에 맡긴다 (BRACKETED_PASTE_SRS FR-BPW-4).
    pub fn send_paste(&self, id: &str, text: &[u8], submit: bool) -> Result<(), Error> {
        let params = PasteParams {
            data: text.to_vec(),
            id: id.to_owned(),
            submit,
        };
        self.call_raw(METHOD_PASTE, &params).map(drop)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), Error> {
        let params = ResizeParams {
            cols,
            id: id.to_owned(),
            rows,
        };
        self.call_raw(METHOD_RESIZE, &params).map(drop)
    }

    /// 응답 없는 입력이다 (FR-OPT-2-2). 알림을 모르는 옛 데몬에는 write RPC 로 강등한다.
    pub fn input_notify(&self, id: &str, data: &[u8]) {
        if !self.has_feature(FEATURE_NOTIFY) {
            let _ = self.write(id, data);
            return;
        }
        let params = WriteParams {
            data: data.to_vec(),
            id: id.to_owned(),
        };
        self.notify(METHOD_INPUT, &params);
    }

    /// 응답 없는 리사이즈다 (FR-OPT-2-2).
    pub fn resize_notify(&self, id: &str, cols: u16, rows: u16) {
        if !self.has_feature(FEATURE_NOTIFY) {
            let _ = self.resize(id, cols, rows);
            return;
        }
        let params = ResizeParams {
            cols,
            id: id.to_owned(),
            rows,
        };
        self.notify(METHOD_RESIZE_NOTIFY, &params);
    }

    /// 도구의 작업 폴더다. 모르면 빈 문자열이다.
    pub fn cwd(&self, id: &str) -> String {
        self.call::<CwdResult, _>(METHOD_CWD, &IdParams { id: id.to_owned() })
            .map(|r| r.cwd)
            .unwrap_or_default()
    }

    pub fn busy(&self, id: &str) -> bool {
        self.call::<BusyResult, _>(METHOD_BUSY, &IdParams { id: id.to_owned() })
            .map(|r| r.busy)
            .unwrap_or_default()
    }

    /// busymany 한 번이다 (FR-OPT-2-4). 옛 데몬에는 busy 를 하나씩 보낸다. 오류가 하나라도 나면
    /// `None` — 모르는 것을 "바쁘지 않음" 으로 읽지 않는다 (IPC-M2).
    pub fn busy_many(&self, ids: &[String]) -> Option<HashMap<String, bool>> {
        if ids.is_empty() {
            return Some(HashMap::new());
        }
        if self.has_feature(FEATURE_BUSY_MANY) {
            let params = BusyManyParams {
                ids: Some(ids.to_vec()),
            };
            let resp: BusyManyResult = self.call(METHOD_BUSY_MANY, &params).ok()?;
            let busy = resp.busy.unwrap_or_default();
            return Some(
                ids.iter()
                    .map(|id| (id.clone(), busy.get(id).copied().unwrap_or(false)))
                    .collect(),
            );
        }
        let mut out = HashMap::with_capacity(ids.len());
        for id in ids {
            let resp: BusyResult = self.call(METHOD_BUSY, &IdParams { id: id.clone() }).ok()?;
            out.insert(id.clone(), resp.busy);
        }
        Some(out)
    }

    /// shellprobe 한 번이다 (FR-RRC-10). 옛 데몬·오류·모르는 값은 `Unknown` 이다 (NFR-RRC-3).
    pub fn shell_probe(&self, id: &str, pids: Option<&[i64]>) -> ShellState {
        if !self.has_feature(FEATURE_SHELL_PROBE) {
            return ShellState::Unknown;
        }
        let params = ShellProbeParams {
            id: id.to_owned(),
            pids: pids.map(<[i64]>::to_vec),
        };
        match self.call::<ShellProbeResult, _>(METHOD_SHELL_PROBE, &params) {
            Ok(r) => ShellState::parse(&r.state),
            Err(_) => ShellState::Unknown,
        }
    }

    /// 도구를 탭에서 떼거나(bg=true) 되돌린다. 도구가 없으면 거짓이다 (FR-BG-2/4/7).
    pub fn set_background(&self, id: &str, bg: bool) -> bool {
        self.inner.invalidate_list();
        let params = SetBackgroundParams {
            background: bg,
            id: id.to_owned(),
        };
        let ok = self
            .call::<SetBackgroundResult, _>(METHOD_SET_BACKGROUND, &params)
            .map(|r| r.ok)
            .unwrap_or_default();
        self.inner.invalidate_list();
        ok
    }

    /// 백그라운드 도구 목록이다 (FR-BG-6). 오류면 빈 목록이다.
    pub fn background_list(&self) -> Vec<BackgroundEntry> {
        self.call::<BackgroundListResult, _>(METHOD_BACKGROUND_LIST, &Empty {})
            .ok()
            .and_then(|r| r.background)
            .unwrap_or_default()
    }

    pub fn snapshot_tool(&self, id: &str) -> Result<ToolSnapshot, Error> {
        self.snapshot_tool_since(id, -1)
    }

    /// 재개 지점을 실어 스냅샷을 부른다 (FR-TRS-3). since<0 은 전량 재생이다. "없음" 은
    /// [`Error::ToolNotFound`] 로 연결 오류와 가른다 (FR-OPT-2-5).
    pub fn snapshot_tool_since(&self, id: &str, since: i64) -> Result<ToolSnapshot, Error> {
        let params = SnapshotParams {
            id: id.to_owned(),
            since,
        };
        let r: SnapshotResult = self.call(METHOD_SNAPSHOT, &params).map_err(|e| match e {
            Error::Rpc(r) if r.code == CODE_NOT_FOUND => Error::ToolNotFound(id.to_owned()),
            e => e,
        })?;
        Ok(ToolSnapshot {
            data: r.data,
            total_bytes_in: r.total_bytes_in,
            total_bytes_drop: r.total_bytes_drop,
            retained: r.retained,
            end: r.end,
            resumed: r.resumed,
            cols: r.cols,
            rows: r.rows,
            modes: r.modes,
        })
    }
}
