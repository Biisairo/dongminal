//! 로컬 API `/api/telegram/*` 과 Telegram 브리지의 이음매 (Go `telegram_api.go`·`telegram_wire.go`,
//! TELEGRAM_BRIDGE_SRS). 본문 오류는 `{code,message}` 방언이다. token 은 받기만 하고 응답·로그에
//! 싣지 않는다 (FR-TGB-3).

use std::sync::{Arc, LazyLock, Weak};
use std::time::Duration;

use http::StatusCode;
use otter_shared_agentrec as agentrec;
use otter_shared_chatwire as chatwire;
use otter_shared_httpresp::{self as httpresp, Response};
use otter_shared_otterlog::infof;
use otter_shared_toolipc::ChatParams;
use otter_webserver_apierr as apierr;
use otter_webserver_domain_telegram as telegram;
use otter_webserver_hub::CommandHub;
use regex::Regex;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio_util::sync::CancellationToken;

use crate::httperr::{code_fail, read_json_body};
use crate::req::Req;
use crate::{Config, Server};

/// Go `tgTokenRe`: BotFather token 의 모양이다. token 은 URL 경로에 들어가므로 다른 글자를 거른다.
static TG_TOKEN_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]{1,20}:[A-Za-z0-9_-]{30,64}$").expect("고정 식"));

/// 개인채팅 방의 종류 (PEER_CHAT_SRS FR-PCH-14).
const CHAT_KIND_DIRECT: &str = "direct";
/// 상대를 모르는 개인채팅의 토픽 이름. 웹 카탈로그 `chat.direct` 와 같다.
const DIRECT_TOPIC_NAME: &str = "개인채팅";

/// Go `tgGetMeTimeout`: token 확인의 상한이다.
const TG_GET_ME_TIMEOUT: Duration = Duration::from_secs(10);

/// Go `telegramSink`: 브리지가 받는 사건들이다. 시험은 기록기를 꽂는다.
pub(crate) trait TelegramSink: Send + Sync {
    fn on_activity(&self, ev: telegram::Event);
    fn on_attention(&self, tool_id: &str, reason: &str);
    fn on_attention_clear(&self, tool_id: &str);
    fn on_tool_gone(&self, tool_id: &str);
    /// 채팅 방이 바뀌었다 (ISSUE_TREE_CHAT_SRS FR-TGT-3).
    fn on_chat_changed(&self);
}

impl TelegramSink for telegram::Bridge {
    fn on_activity(&self, ev: telegram::Event) {
        telegram::Bridge::on_activity(self, ev);
    }
    fn on_attention(&self, tool_id: &str, reason: &str) {
        telegram::Bridge::on_attention(self, tool_id, reason);
    }
    fn on_attention_clear(&self, tool_id: &str) {
        telegram::Bridge::on_attention_clear(self, tool_id);
    }
    fn on_tool_gone(&self, tool_id: &str) {
        telegram::Bridge::on_tool_gone(self, tool_id);
    }
    fn on_chat_changed(&self) {
        telegram::Bridge::on_chat_changed(self);
    }
}

/// Go `telegramWire`: 서버와 Telegram 브리지의 이음매다.
pub(crate) struct TelegramWire {
    pub(crate) st: Arc<telegram::Store>,
    pub(crate) sink: Arc<dyn TelegramSink>,
    pub(crate) bridge: Option<Arc<telegram::Bridge>>,
}

/// Go `initTelegram`: 설정 파일과 브리지를 세운다. data_dir 이 없으면 세우지 않는다.
pub(crate) fn init_telegram(cfg: &Config, me: Weak<Server>) -> Option<TelegramWire> {
    if cfg.data_dir.as_os_str().is_empty() {
        return None;
    }
    let st = Arc::new(telegram::Store::open(
        cfg.data_dir.join(otter_shared_otterenv::TELEGRAM_FILE),
    ));
    let now: telegram::NowFn = Arc::new(OffsetDateTime::now_utc);
    let b = telegram::Bridge::new(
        st.clone(),
        Arc::new(TelegramHost(me)),
        &cfg.telegram_api,
        now,
    );
    Some(TelegramWire {
        st,
        sink: b.clone(),
        bridge: Some(b),
    })
}

#[derive(Serialize)]
struct PairView {
    #[serde(with = "otter_gocompat::time::json_time")]
    expires: OffsetDateTime,
}

/// Go `telegramView`: GET /api/telegram 이다. 진행 중 코드는 만료만 싣는다.
#[derive(Serialize)]
struct TelegramView {
    enabled: bool,
    #[serde(rename = "tokenSet")]
    token_set: bool,
    #[serde(rename = "botName")]
    bot_name: String,
    paired: bool,
    #[serde(rename = "silenceMin")]
    silence_min: i64,
    pair: Option<PairView>,
    /// ISSUE_TREE_CHAT_SRS FR-TGT-1. 꺼져 있으면 싣지 않는다 — Go 기준 골든 그대로다.
    #[serde(rename = "chatTopics", skip_serializing_if = "std::ops::Not::not")]
    chat_topics: bool,
}

#[derive(Serialize)]
struct PairIssued {
    code: String,
    #[serde(with = "otter_gocompat::time::json_time")]
    expires: OffsetDateTime,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TokenReq {
    token: String,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct EnabledReq {
    enabled: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct TopicsReq {
    topics: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SilenceReq {
    minutes: i64,
}

impl Server {
    /// Go `telegramReady`.
    fn telegram_ready(&self) -> Result<(&TelegramWire, &Arc<telegram::Bridge>), Response> {
        match &self.tg {
            Some(tg) => match &tg.bridge {
                Some(b) => Ok((tg, b)),
                None => Err(telegram_unavailable()),
            },
            None => Err(telegram_unavailable()),
        }
    }

    fn telegram_view(&self, tg: &TelegramWire, b: &telegram::Bridge) -> TelegramView {
        let v = tg.st.view();
        TelegramView {
            enabled: v.enabled,
            token_set: v.token_set,
            bot_name: v.bot_name,
            paired: v.paired,
            silence_min: v.silence_min,
            pair: b.pairing().pending().map(|expires| PairView { expires }),
            chat_topics: v.chat_topics,
        }
    }

    /// Go `telegramSaved`: 저장 오류를 답하거나 바뀐 화면 값을 돌려준다.
    fn telegram_saved(
        &self,
        tg: &TelegramWire,
        b: &telegram::Bridge,
        res: Result<(), telegram::StoreError>,
    ) -> Response {
        match res {
            Ok(()) => {
                self.refresh_full_topic("telegram");
                httpresp::json(StatusCode::OK, &self.telegram_view(tg, b))
            }
            Err(e @ telegram::StoreError::InvalidSilence) => code_fail(
                StatusCode::BAD_REQUEST,
                apierr::CODE_TELEGRAM_CONFIG_INVALID,
                &e.to_string(),
            ),
            Err(e @ telegram::StoreError::TopicsNeedBridge) => code_fail(
                StatusCode::CONFLICT,
                apierr::CODE_TELEGRAM_TOPICS_NEED_BRIDGE,
                &e.to_string(),
            ),
            Err(_) => code_fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_SAVE_FAILED,
                "save failed",
            ),
        }
    }

    pub(crate) async fn api_telegram_get(&self, _r: &mut Req) -> Response {
        match self.telegram_ready() {
            Ok((tg, b)) => httpresp::json(StatusCode::OK, &self.telegram_view(tg, b)),
            Err(res) => res,
        }
    }

    /// Go `apiTelegramToken`: token 을 getMe 로 확인하고 저장한다 (FR-TGB-4). 바뀌면 허용 계정이
    /// 지워진다 (FR-TGB-5).
    pub(crate) async fn api_telegram_token(&self, r: &mut Req) -> Response {
        let (tg, b) = match self.telegram_ready() {
            Ok(v) => v,
            Err(res) => return res,
        };
        let req: TokenReq = match read_json_body(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        if !TG_TOKEN_RE.is_match(&req.token) {
            return code_fail(
                StatusCode::BAD_REQUEST,
                apierr::CODE_TELEGRAM_TOKEN_INVALID,
                "token is malformed",
            );
        }
        let client = telegram::Client::new(&self.cfg.telegram_api, &req.token);
        let me = tokio::select! {
            got = tokio::time::timeout(TG_GET_ME_TIMEOUT, client.get_me()) => got,
            () = r.ctx.cancelled() => return telegram_unreachable(),
        };
        let me = match me {
            Ok(Ok(me)) => me,
            Ok(Err(e)) if e.api().is_some() => {
                return code_fail(
                    StatusCode::BAD_REQUEST,
                    apierr::CODE_TELEGRAM_TOKEN_INVALID,
                    "telegram rejected the token",
                );
            }
            Ok(Err(e)) => {
                infof!(None, "telegram: token 확인 실패: {e}");
                return telegram_unreachable();
            }
            Err(_) => {
                infof!(None, "telegram: token 확인 실패: context deadline exceeded");
                return telegram_unreachable();
            }
        };
        // 바꾸기 전에 만든 등록 코드는 그 봇을 위한 것이다. 허용 계정과 함께 버린다.
        b.pairing().cancel();
        self.telegram_saved(tg, b, tg.st.set_token(&req.token, &me.username))
    }

    pub(crate) async fn api_telegram_enabled(&self, r: &mut Req) -> Response {
        let (tg, b) = match self.telegram_ready() {
            Ok(v) => v,
            Err(res) => return res,
        };
        let req: EnabledReq = match read_json_body(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        self.telegram_saved(tg, b, tg.st.set_enabled(req.enabled))
    }

    pub(crate) async fn api_telegram_silence(&self, r: &mut Req) -> Response {
        let (tg, b) = match self.telegram_ready() {
            Ok(v) => v,
            Err(res) => return res,
        };
        let req: SilenceReq = match read_json_body(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        self.telegram_saved(tg, b, tg.st.set_silence(req.minutes))
    }

    /// ISSUE_TREE_CHAT_SRS FR-TGT-1·2: 채팅 토픽을 켜고 끈다. 켤 때는 전제(켜기·token·허용 계정)를 보고, getMe 로 봇의
    /// 1:1 대화방 토픽 모드를 확인한다. 꺼져 있으면 켜지 않고 켜는 법을 알리는 코드로 답한다.
    pub(crate) async fn api_telegram_topics(&self, r: &mut Req) -> Response {
        let (tg, b) = match self.telegram_ready() {
            Ok(v) => v,
            Err(res) => return res,
        };
        let req: TopicsReq = match read_json_body(r).await {
            Ok(v) => v,
            Err(res) => return res,
        };
        let c = tg.st.config();
        if req.topics && c.enabled && !c.token.is_empty() && c.user_id != 0 {
            let client = telegram::Client::new(&self.cfg.telegram_api, &c.token);
            let me = tokio::select! {
                got = tokio::time::timeout(TG_GET_ME_TIMEOUT, client.get_me()) => got,
                () = r.ctx.cancelled() => return telegram_unreachable(),
            };
            match me {
                Ok(Ok(me)) if me.has_topics_enabled => {}
                Ok(Ok(_)) => {
                    return code_fail(
                        StatusCode::CONFLICT,
                        apierr::CODE_TELEGRAM_TOPICS_MODE_OFF,
                        "bot topic mode is off",
                    );
                }
                Ok(Err(e)) => {
                    infof!(None, "telegram: 토픽 모드 확인 실패: {e}");
                    return telegram_unreachable();
                }
                Err(_) => return telegram_unreachable(),
            }
        }
        let res = tg.st.set_chat_topics(req.topics);
        if res.is_ok() {
            self.telegram_chat_changed();
        }
        self.telegram_saved(tg, b, res)
    }

    /// Go `apiTelegramPair`: 등록 코드를 만든다 (FR-TGB-10). 코드는 이 응답에만 있다.
    pub(crate) async fn api_telegram_pair(&self, _r: &mut Req) -> Response {
        let (tg, b) = match self.telegram_ready() {
            Ok(v) => v,
            Err(res) => return res,
        };
        if !tg.st.view().token_set {
            return code_fail(
                StatusCode::CONFLICT,
                apierr::CODE_TELEGRAM_NO_TOKEN,
                "no bot token",
            );
        }
        let (code, expires) = b.pairing().issue();
        if code.is_empty() {
            return code_fail(
                StatusCode::INTERNAL_SERVER_ERROR,
                apierr::CODE_INTERNAL,
                "could not make a code",
            );
        }
        self.refresh_full_topic("telegram");
        httpresp::json(StatusCode::OK, &PairIssued { code, expires })
    }

    /// Go `apiTelegramUnpair`: 허용 계정을 지우고 살아 있는 코드도 죽인다.
    pub(crate) async fn api_telegram_unpair(&self, _r: &mut Req) -> Response {
        let (tg, b) = match self.telegram_ready() {
            Ok(v) => v,
            Err(res) => return res,
        };
        b.pairing().cancel();
        self.telegram_saved(tg, b, tg.st.set_user(0))
    }

    /// Go `telegramActivity`: main 에이전트의 hook 보고를 브리지 사건으로 옮긴다 (FR-TGB-80·81).
    /// 꺼져 있으면 아무것도 하지 않는다 (FR-TGB-82 · NFR-TGB-1).
    pub(crate) fn telegram_activity(&self, req: &agentrec::ActivityReport) {
        let Some(tg) = &self.tg else {
            return;
        };
        if !tg.st.view().enabled {
            return;
        }
        tg.sink.on_activity(telegram::Event {
            tool_id: req.tool_id.clone(),
            hook: req.hook.clone(),
            tool: req.tool.clone(),
            detail: req.detail.clone(),
            input: req.input.0.clone(),
            input_over: req.input_over,
            transcript: req.transcript.clone(),
        });
    }

    /// Go `wireTelegramAttention`: PC 알람과 그 해제, 도구가 사라진 것을 브리지에 넘긴다 (FR-TGB-50·
    /// 58b · GD-12). 서버가 허브를 만들면 스스로 부른다 — 허브를 주입하는 합성 루트는 그 허브로 부른다.
    pub fn wire_telegram_attention(&self, hub: &CommandHub) {
        let Some(tg) = &self.tg else {
            return;
        };
        let s = tg.sink.clone();
        hub.set_attention_observer(Some(Arc::new(move |id: &str, reason: &str| {
            s.on_attention(id, reason);
        })));
        let s = tg.sink.clone();
        hub.set_attention_clear_observer(Some(Arc::new(move |id: &str| s.on_attention_clear(id))));
        let s = tg.sink.clone();
        hub.set_tool_gone_observer(Some(Arc::new(move |id: &str| s.on_tool_gone(id))));
    }

    /// 채팅 방이 바뀌었다 — 브리지가 거울 토픽을 맞춘다 (ISSUE_TREE_CHAT_SRS FR-TGT-3). 채팅 토픽이 꺼져 있으면
    /// 브리지가 거른다 (NFR-ITH-4).
    pub(crate) fn telegram_chat_changed(&self) {
        if let Some(tg) = &self.tg {
            tg.sink.on_chat_changed();
        }
    }

    /// Go `StartTelegram`: 브리지를 돌리고, stop 이 취소되면 멈춘다. 돌려준 task 는 멈춘 뒤 끝난다.
    /// 꺼져 있으면 브리지는 Telegram 에 아무 요청도 하지 않는다 (NFR-TGB-1).
    pub fn start_telegram(&self, stop: CancellationToken) -> tokio::task::JoinHandle<()> {
        match self.tg.as_ref().and_then(|tg| tg.bridge.clone()) {
            Some(b) => {
                b.on_chat_changed();
                tokio::spawn(b.run(stop))
            }
            None => tokio::spawn(async {}),
        }
    }
}

fn telegram_unavailable() -> Response {
    code_fail(
        StatusCode::SERVICE_UNAVAILABLE,
        apierr::CODE_TELEGRAM_UNAVAILABLE,
        "telegram bridge unavailable",
    )
}

fn telegram_unreachable() -> Response {
    code_fail(
        StatusCode::BAD_GATEWAY,
        apierr::CODE_TELEGRAM_UNREACHABLE,
        "telegram unreachable",
    )
}

/// Go `telegramHost`: `telegram::Host` 의 서버 구현이다. 기존 문만 지난다.
pub(crate) struct TelegramHost(pub(crate) Weak<Server>);

impl telegram::Host for TelegramHost {
    /// 짝맞춤이 끝났다 — 열린 설정 화면이 `telegram` 토픽으로 안다 (CHANNEL_PROTOCOL C2b).
    fn paired(&self) {
        if let Some(s) = self.0.upgrade() {
            s.refresh_full_topic("telegram");
        }
    }

    fn last_browser_input(&self, tool_id: &str) -> Option<OffsetDateTime> {
        self.0
            .upgrade()?
            .last_browser_input(tool_id)
            .map(OffsetDateTime::from)
    }

    /// 기기 › 윈도우 › 탭 이다 (FR-TGB-56). 기기는 핸들, 비면 호스트 이름이다 (D-TGB-17). 탭 이름이
    /// 없으면 전경 이름, 그것도 없으면 도구 id 다.
    fn location(&self, tool_id: &str) -> telegram::Location {
        let Some(s) = self.0.upgrade() else {
            return telegram::Location {
                tab: tool_id.to_owned(),
                ..Default::default()
            };
        };
        let mut loc = telegram::Location {
            device: device(&s),
            tab: tool_id.to_owned(),
            ..Default::default()
        };
        if let Some(w) = &s.deps.work_index
            && let Some(e) = w.entries().into_iter().find(|e| e.tool_id == tool_id)
        {
            loc.window = e.window_name;
            if !e.tab_name.is_empty() {
                loc.tab = e.tab_name;
                return loc;
            }
        }
        if let Some(io) = &s.deps.tool_io {
            for t in io.list() {
                if t.id == tool_id && !t.foreground_name.is_empty() {
                    loc.tab = t.foreground_name;
                }
            }
        }
        loc
    }

    /// PC 알람을 끈다. 포커스와 같은 문이다 (FR-TGB-58a).
    fn attend(&self, tool_id: &str, typed: bool) {
        if let Some(s) = self.0.upgrade() {
            s.attention().attend(tool_id, typed);
        }
    }

    /// 사람 참가자의 채팅 상태에서 방을 옮긴다 (ISSUE_TREE_CHAT_SRS FR-TGT-3). 데몬 RPC 라 막힐 수 있다.
    fn chat_rooms(&self) -> Option<Vec<telegram::ChatRoom>> {
        let d = self.0.upgrade()?.deps.chat_daemon.clone()?;
        if !d.chat_ready() {
            return None;
        }
        let res = d
            .chat(ChatParams {
                op: chatwire::OP_STATE.to_owned(),
                ..ChatParams::default()
            })
            .ok()?;
        if res.error.is_some() {
            return None;
        }
        let st: chatwire::State = otter_gocompat::json::unmarshal(&res.result.0).ok()?;
        let rooms = st.rooms.unwrap_or_default();
        Some(rooms.iter().map(|r| chat_room(r, &st.me.id)).collect())
    }
}

/// 방 하나의 거울 값. 단체채팅은 겹친 `#` 없는 방 이름, 개인채팅은 상대의 표시 이름이다 (FR-CUX-9·14).
fn chat_room(r: &chatwire::Room, me: &str) -> telegram::ChatRoom {
    let name = if r.kind == CHAT_KIND_DIRECT {
        r.people.iter().flatten().find(|p| p.id != me).map_or_else(
            || DIRECT_TOPIC_NAME.to_owned(),
            |p| telegram::display_name(&p.label, &p.id, me),
        )
    } else {
        r.name.trim_start_matches('#').to_owned()
    };
    telegram::ChatRoom {
        id: r.id.clone(),
        name,
        purpose: r.purpose.clone(),
        members: r.members,
        joined: r.joined,
    }
}

/// Go `telegramHost.device`: 이 기기의 핸들이다. 노드가 없으면 OS 호스트 이름이다 (FR-PFN-21).
fn device(s: &Server) -> String {
    let h = s.profile_handle();
    if !h.is_empty() {
        return h;
    }
    otter_shared_platform::hostname().unwrap_or_default()
}
