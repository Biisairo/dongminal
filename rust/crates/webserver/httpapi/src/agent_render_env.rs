//! 에이전트가 화면을 망가뜨리지 않게 띄운다 (Go `agent_render_env.go`, AGENT_RENDER_ENV_SRS).
//!
//! Claude Code 의 fullscreen 렌더링을 켜는 환경 변수와 스크롤 속도를 새 도구에 얹는다.
//! Codex·oh-my-pi 는 대상이 아니다 (SRS §1.3).

use std::sync::LazyLock;

use dm_shared_settingsschema::{self as settingsschema, Spec};
use serde_json::{Map, Value};

/// 이 스위치의 설정 키다 (Settings ▸ Terminal).
pub(crate) const AGENT_RENDER_ENV_KEY: &str = "claudeFullscreen";
/// 강제가 아니다 (FR-ARE-2) — 사용자가 `/tui default` 를 치면 Claude Code 가 지운다.
pub(crate) const CLAUDE_NO_FLICKER_ENV: &str = "CLAUDE_CODE_NO_FLICKER=1";
/// 스크롤 속도의 설정 키다 (FR-ARE-8).
pub(crate) const SCROLL_SPEED_KEY: &str = "claudeScrollSpeed";
pub(crate) const CLAUDE_SCROLL_SPEED_ENV: &str = "CLAUDE_CODE_SCROLL_SPEED";

/// 서술자 표의 `claudeScrollSpeed` 다 (FR-CFG-1). 표를 읽지 못하면 영 서술자다.
static SCROLL_SPEED_SPEC: LazyLock<Spec> = LazyLock::new(|| match settingsschema::load() {
    Ok(specs) => settingsschema::by_key(&specs)
        .remove(SCROLL_SPEED_KEY)
        .unwrap_or_default(),
    Err(_) => Spec::default(),
});

/// `claudeFullscreen` 의 기본값이다 (FR-SDA-82).
static FULLSCREEN_DEFAULT: LazyLock<bool> =
    LazyLock::new(|| fullscreen_default_from(settingsschema::load().ok().as_deref()));

/// Go `fullscreenDefaultFrom`. 표를 읽지 못하거나 값이 불리언이 아니면 켬이다 (FR-ARE-3).
pub(crate) fn fullscreen_default_from(specs: Option<&[Spec]>) -> bool {
    let Some(specs) = specs else {
        return true;
    };
    settingsschema::by_key(specs)
        .get(AGENT_RENDER_ENV_KEY)
        .and_then(|s| s.def.as_bool())
        .unwrap_or(true)
}

/// Go `scrollSpeed`: 언제나 값을 낸다. 읽을 것이 없거나 범위를 벗어나면 표의 기본값이다
/// (FR-ARE-9). 표가 없으면 `None` 이다.
fn scroll_speed(m: Option<&Map<String, Value>>) -> Option<i64> {
    let spec = &*SCROLL_SPEED_SPEC;
    if spec.key.is_empty() {
        return None;
    }
    let def = spec.def.as_f64()?;
    let mut n = go_int(def);
    if let Some(v) = m
        .and_then(|m| m.get(SCROLL_SPEED_KEY))
        .and_then(Value::as_f64)
    {
        // 정수만 받는다 — 표가 `int` 로 선언하고, 실수는 그 선언 밖이다.
        let i = go_int(v);
        if i as f64 == v && spec.min.is_none_or(|lo| i >= lo) && spec.max.is_none_or(|hi| i <= hi) {
            n = i;
        }
    }
    Some(n)
}

/// Go `int(float64)` (64비트 대상, 범위 밖은 포화).
fn go_int(v: f64) -> i64 {
    v as i64
}

/// Go `agentRenderEnv`: 설정 blob 을 보고 새 도구에 얹을 환경을 낸다 (FR-ARE-7).
pub(crate) fn agent_render_env(blob: &[u8]) -> Vec<String> {
    let mut on = *FULLSCREEN_DEFAULT;
    let mut m: Option<Map<String, Value>> = None;
    if !blob.is_empty() {
        match dm_gocompat::json::unmarshal::<Value>(blob) {
            Ok(Value::Object(obj)) => {
                if let Some(v) = obj.get(AGENT_RENDER_ENV_KEY).and_then(Value::as_bool) {
                    on = v;
                }
                m = Some(obj);
            }
            // `null` 은 Go 에서 nil 맵이다 — 오류가 아니지만 읽을 것도 없다.
            _ => m = None,
        }
    }
    let mut env = Vec::new();
    if on {
        env.push(CLAUDE_NO_FLICKER_ENV.to_owned());
    }
    // FR-ARE-8·9: 스크롤 속도는 **항상** 간다. 위의 갈래와 독립이다.
    if let Some(n) = scroll_speed(m.as_ref()) {
        env.push(format!("{CLAUDE_SCROLL_SPEED_ENV}={n}"));
    }
    env
}
