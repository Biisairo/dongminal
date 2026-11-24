//! 사용량 응답과 그 해석, 라인과 묶는 창 (FR-CAC-71, cswap `lines.py`).

use std::collections::HashSet;

use otter_gocompat::json::{self, RawMessage, is_empty};
use serde::{Deserialize, Serialize};

use crate::error::Error;

const ERR_USAGE_SHAPE: &str = "사용량 응답을 읽을 수 없습니다";

/// 판단에 넣을 모델 이름들. `None` 이면 모든 scoped 창이다.
pub type Models = Option<HashSet<String>>;

/// 한도 창 하나다. `resets_at` 은 unix 초이고 모르면 0 이다.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.Window")]
pub struct Window {
    pub pct: f64,
    #[serde(rename = "resetsAt", skip_serializing_if = "is_empty")]
    pub resets_at: i64,
}

/// 모델별 주간 한도다. Go 는 `Window` 를 임베드한다.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.ScopedWindow")]
pub struct ScopedWindow {
    pub name: String,
    pub pct: f64,
    #[serde(rename = "resetsAt", skip_serializing_if = "is_empty")]
    pub resets_at: i64,
}

impl ScopedWindow {
    pub fn window(&self) -> Window {
        Window {
            pct: self.pct,
            resets_at: self.resets_at,
        }
    }
}

/// 추가 사용량이다 (FR-CAC-52).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.Spend")]
pub struct Spend {
    pub used: f64,
    pub limit: f64,
    pub pct: f64,
    pub currency: String,
}

/// 한 계정의 사용량이다.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename = "claudeacct.Usage")]
pub struct Usage {
    #[serde(rename = "fiveHour", skip_serializing_if = "is_empty")]
    pub five_hour: Option<Window>,
    #[serde(rename = "sevenDay", skip_serializing_if = "is_empty")]
    pub seven_day: Option<Window>,
    #[serde(skip_serializing_if = "is_empty")]
    pub scoped: Vec<ScopedWindow>,
    #[serde(skip_serializing_if = "is_empty")]
    pub spend: Option<Spend>,
}

/// RFC3339 시각을 unix 초로. 비었거나 읽을 수 없으면 0 이다.
pub(crate) fn parse_resets_at(s: &str) -> i64 {
    if s.is_empty() {
        return 0;
    }
    otter_gocompat::time::parse_rfc3339_nano(s).map_or(0, |t| t.unix_timestamp())
}

/// 사용량 응답을 해석한다. 창이 하나도 없거나 형식이 틀리면 오류다.
pub fn parse_usage(raw: &[u8]) -> Result<Usage, Error> {
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Win {
        utilization: Option<f64>,
        resets_at: String,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Extra {
        is_enabled: bool,
        used_credits: Option<f64>,
        monthly_limit: Option<f64>,
        utilization: Option<f64>,
        currency: String,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct V {
        five_hour: Option<Win>,
        seven_day: Option<Win>,
        extra_usage: Option<Extra>,
        limits: Option<Vec<RawMessage>>,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Model {
        display_name: String,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Scope {
        model: Option<Model>,
    }
    #[derive(Deserialize, Default)]
    #[serde(default)]
    struct Limit {
        scope: Option<Scope>,
        percent: Option<f64>,
        resets_at: String,
    }
    let v = json::unmarshal::<V>(raw).map_err(|_| Error::new(ERR_USAGE_SHAPE))?;
    let conv = |w: Option<Win>| {
        w.and_then(|w| {
            w.utilization.map(|pct| Window {
                pct,
                resets_at: parse_resets_at(&w.resets_at),
            })
        })
    };
    let mut u = Usage {
        five_hour: conv(v.five_hour),
        seven_day: conv(v.seven_day),
        ..Usage::default()
    };
    if let Some(e) = v.extra_usage
        && e.is_enabled
        && let (Some(used), Some(limit), Some(pct)) =
            (e.used_credits, e.monthly_limit, e.utilization)
    {
        let currency = if e.currency.is_empty() {
            "USD".to_owned()
        } else {
            e.currency
        };
        u.spend = Some(Spend {
            used: used / 100.0,
            limit: limit / 100.0,
            pct,
            currency,
        });
    }
    for raw in v.limits.unwrap_or_default() {
        let Ok(l) = json::unmarshal::<Limit>(&raw.0) else {
            continue;
        };
        let name = l
            .scope
            .and_then(|s| s.model)
            .map(|m| m.display_name)
            .unwrap_or_default();
        let Some(pct) = l.percent else { continue };
        if name.is_empty() {
            continue;
        }
        u.scoped.push(ScopedWindow {
            name,
            pct,
            resets_at: parse_resets_at(&l.resets_at),
        });
    }
    if u.five_hour.is_none() && u.seven_day.is_none() && u.scoped.is_empty() {
        return Err(Error::new(ERR_USAGE_SHAPE));
    }
    Ok(u)
}

fn selected(models: &Models, name: &str) -> bool {
    models.as_ref().is_none_or(|m| m.contains(name))
}

/// 판단에 넣을 창과 그 창이 5시간 창인지다.
#[derive(Debug, Clone)]
pub(crate) struct LabeledWindow {
    pub(crate) window: Window,
    pub(crate) name: String,
    pub(crate) five: bool,
}

/// 계정을 붙잡는 창이다.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Binding {
    pub(crate) name: String,
    pub(crate) pct: f64,
    pub(crate) line: f64,
    pub(crate) resets_at: i64,
    pub(crate) line_headroom: f64,
    pub(crate) over: bool,
}

impl Usage {
    /// 판단에 넣을 창이다. models 가 `None` 이면 모든 scoped 창을, 아니면 그 이름만 넣는다.
    pub(crate) fn windows(&self, models: &Models) -> Vec<Window> {
        let mut out: Vec<Window> = self
            .five_hour
            .iter()
            .chain(&self.seven_day)
            .copied()
            .collect();
        out.extend(
            self.scoped
                .iter()
                .filter(|s| selected(models, &s.name))
                .map(ScopedWindow::window),
        );
        out
    }

    /// `100 - max(사용률)` 이다 (§1.3).
    pub fn headroom(&self, models: &Models) -> f64 {
        let mut max_pct = 0.0;
        for w in self.windows(models) {
            if w.pct > max_pct {
                max_pct = w.pct;
            }
        }
        100.0 - max_pct
    }

    pub(crate) fn labeled(&self, models: &Models) -> Vec<LabeledWindow> {
        let mut out = Vec::new();
        if let Some(w) = self.five_hour {
            out.push(LabeledWindow {
                window: w,
                name: "five_hour".to_owned(),
                five: true,
            });
        }
        if let Some(w) = self.seven_day {
            out.push(LabeledWindow {
                window: w,
                name: "seven_day".to_owned(),
                five: false,
            });
        }
        for s in self.scoped.iter().filter(|s| selected(models, &s.name)) {
            out.push(LabeledWindow {
                window: s.window(),
                name: s.name.clone(),
                five: false,
            });
        }
        out
    }
}

/// 창 하나의 라인 헤드룸이다. 0%→100, 라인→100-scale, 100%→0 의 구간 선형이다.
pub(crate) fn line_headroom(pct: f64, line: f64, scale: f64) -> f64 {
    if line == scale {
        return 100.0 - pct;
    }
    if line >= 100.0 && pct >= 100.0 {
        return 0.0;
    }
    if pct <= line {
        return (100.0 - scale) + scale * (line - pct) / line;
    }
    (100.0 - scale) * (100.0 - pct) / (100.0 - line)
}

/// 라인을 넘은 창을 먼저, 그다음 라인 헤드룸이 가장 작은 창을 고른다. weekly 가 `None` 이면
/// 모든 창이 threshold 를 라인으로 쓴다. 창이 없으면 `None`.
pub(crate) fn binding_of(
    u: &Usage,
    models: &Models,
    threshold: f64,
    weekly: Option<f64>,
    scale: f64,
) -> Option<Binding> {
    let mut best: Option<Binding> = None;
    for w in u.labeled(models) {
        let line = match weekly {
            Some(wk) if !w.five => wk,
            _ => threshold,
        };
        let b = Binding {
            name: w.name,
            pct: w.window.pct,
            line,
            resets_at: w.window.resets_at,
            line_headroom: line_headroom(w.window.pct, line, scale),
            over: w.window.pct >= line,
        };
        let take = match &best {
            None => true,
            Some(cur) => {
                (b.over && !cur.over) || (b.over == cur.over && b.line_headroom < cur.line_headroom)
            }
        };
        if take {
            best = Some(b);
        }
    }
    best
}
