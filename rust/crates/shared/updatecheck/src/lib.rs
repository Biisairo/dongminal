//! Go 기준선 `dongminal/internal/shared/updatecheck` 의 Rust 포팅. RUST_PORT_SRS 참고.
//!
//! 최신 판을 캐시 한 칸에 담아 둔다 (UPDATE_NOTICE_SRS 묶음 확인). 끈 것은 실제로 나가지 않는다
//! (§1.2): 꺼짐 판정은 확인의 입구에 있고, 날아가는 중에 꺼졌으면 돌아온 답도 버린다.
//! 낡음 가드를 두지 않는다 (D-UPD-8). 억제는 single-flight 하나뿐이다.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::runtime::Handle;
use tokio::task::AbortHandle;

/// 트리거 ③ 의 주기다 (FR-UPD-2). 보조다.
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// 지금 캐시에 든 것 전부다. 화면은 이 값만 보고 배지를 정한다.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename = "updatecheck.Snapshot")]
pub struct Snapshot {
    pub enabled: bool,
    pub current: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub latest: String,
    pub newer: bool,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub link: String,
    #[serde(rename = "checkedAt", skip_serializing_if = "String::is_empty")]
    pub checked_at: String,
    pub failed: bool,
}

pub type Getenv = Arc<dyn Fn(&str) -> String + Send + Sync>;
pub type Broadcast = Arc<dyn Fn() + Send + Sync>;

/// 확인기의 재료다.
#[derive(Clone, Default)]
pub struct Options {
    /// 토글이 남는 자리다 (`server.json`).
    pub home: PathBuf,
    /// 지금 도는 판이다. `dev` 면 견줄 기준이 없다.
    pub current: String,
    /// 기동 시점의 토글이다.
    pub enabled: bool,
    /// 검사가 바꿔 끼우는 자리다. 비면 실제 릴리스 API 다.
    pub endpoint: String,
    /// 트리거 ③ 의 주기다. 0 이면 [`DEFAULT_INTERVAL`].
    pub interval: Duration,
    /// 킬스위치를 읽는 자리다. `None` 이면 늘 빈 값이다.
    pub getenv: Option<Getenv>,
    /// 결과가 바뀌었을 때만 불린다 (FR-UPD-8a·8b).
    pub broadcast: Option<Broadcast>,
}

/// 캐시 한 칸과 그것을 채우는 규약이다. 복제는 같은 칸을 가리킨다.
#[derive(Clone)]
pub struct Checker {
    inner: Arc<Inner>,
}

struct Inner {
    opt: Options,
    killed: bool,
    /// `new` 를 부른 tokio 런타임. 없으면 확인·타이머를 OS 스레드에서 돌린다.
    rt: Option<Handle>,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    enabled: bool,
    snap: Snapshot,
    inflight: bool,
    stopped: bool,
    /// 타이머 세대. disarm 마다 올라가, 깨어난 낡은 타이머가 스스로 물러난다.
    timer_gen: u64,
    timer: Option<AbortHandle>,
    on_settle: Option<Broadcast>,
}

impl Checker {
    /// 확인기를 만든다. 아무것도 시작하지 않는다 — 시작은 [`Checker::start`] 다.
    pub fn new(mut opt: Options) -> Self {
        if opt.interval.is_zero() {
            opt.interval = DEFAULT_INTERVAL;
        }
        let killed = opt
            .getenv
            .as_ref()
            .is_some_and(|g| g(dm_shared_dmenv::ENV_NO_CHECK) == "1");
        let enabled = opt.enabled;
        let snap = Snapshot {
            enabled: enabled && !killed,
            current: opt.current.clone(),
            ..Snapshot::default()
        };
        Self {
            inner: Arc::new(Inner {
                opt,
                killed,
                rt: Handle::try_current().ok(),
                state: Mutex::new(State {
                    enabled,
                    snap,
                    ..State::default()
                }),
            }),
        }
    }

    /// 트리거 ① 이다. 기동 확인 한 번과 마감 타이머를 건다.
    pub fn start(&self) {
        self.trigger();
        let mut st = self.inner.lock();
        self.arm(&mut st);
    }

    /// 트리거 ②·③·④ 의 공통 입구다. 기다리지 않는다 (NFR-UPD-2).
    pub fn trigger(&self) {
        {
            let mut st = self.inner.lock();
            // 진행 중인 확인이 있으면 그 결과에 합류한다 (FR-UPD-2b).
            if st.stopped || !self.inner.effective(&st) || st.inflight {
                return;
            }
            st.inflight = true;
        }
        let me = self.clone();
        self.spawn(async move { me.run().await });
    }

    /// 캐시를 읽는다. 네트워크도 디스크도 만지지 않는다 (NFR-UPD-3).
    pub fn snapshot(&self) -> Snapshot {
        let st = self.inner.lock();
        let mut s = st.snap.clone();
        s.enabled = self.inner.effective(&st);
        s
    }

    /// 토글을 바꾸고 `server.json` 에 적는다 (FR-UPD-13·14). 끔→켬 만이 트리거 ④ 다.
    pub fn set_enabled(&self, on: bool) -> Result<(), dm_shared_serverconf::Error> {
        let was = {
            let mut st = self.inner.lock();
            let was = st.enabled;
            st.enabled = on;
            if !on {
                disarm(&mut st);
            }
            was
        };
        dm_shared_serverconf::set_update_check(&self.inner.opt.home, on)?;
        if on && !was {
            self.trigger();
            let mut st = self.inner.lock();
            self.arm(&mut st);
        }
        Ok(())
    }

    /// 타이머를 푼다. 진행 중인 확인은 끝나되 그 결과는 쓰이지 않는다.
    pub fn stop(&self) {
        let mut st = self.inner.lock();
        st.stopped = true;
        disarm(&mut st);
    }

    /// 다음 마감을 건다.
    fn arm(&self, st: &mut State) {
        disarm(st);
        if st.stopped || !self.inner.effective(st) {
            return;
        }
        let generation = st.timer_gen;
        let interval = self.inner.opt.interval;
        let me = self.clone();
        let fire = move || {
            let live = {
                let st = me.inner.lock();
                st.timer_gen == generation
            };
            if live {
                me.trigger();
            }
        };
        st.timer = match &self.inner.rt {
            Some(h) => Some(
                h.spawn(async move {
                    tokio::time::sleep(interval).await;
                    fire();
                })
                .abort_handle(),
            ),
            None => {
                std::thread::spawn(move || {
                    std::thread::sleep(interval);
                    fire();
                });
                None
            }
        };
    }

    fn spawn(&self, fut: impl Future<Output = ()> + Send + 'static) {
        match &self.inner.rt {
            Some(h) => {
                h.spawn(fut);
            }
            None => {
                std::thread::spawn(move || {
                    if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                    {
                        rt.block_on(fut);
                    }
                });
            }
        }
    }

    /// 확인 한 회다. 밖으로 나가는 유일한 자리다.
    async fn run(&self) {
        let res = dm_shared_release::latest(&self.inner.opt.endpoint).await;

        let (changed, cast, settle) = {
            let mut st = self.inner.lock();
            let mut changed = false;
            // 날아간 사이에 꺼졌으면 돌아온 답은 버린다 (§1.2).
            if self.inner.effective(&st) && !st.stopped {
                let mut next = st.snap.clone();
                next.current = self.inner.opt.current.clone();
                match res {
                    Err(e) => {
                        // 실패는 캐시를 바꾸지 않는다 (FR-UPD-2e). 조용히 로그에만 남긴다 (FR-UPD-4).
                        next.failed = true;
                        dm_shared_dmlog::warnf!(None, "판 확인 실패: {e}");
                    }
                    Ok((tag, link)) => {
                        let current = &self.inner.opt.current;
                        next.failed = false;
                        next.newer = dm_shared_release::comparable(current)
                            && dm_shared_release::newer(&tag, current);
                        next.latest = tag;
                        next.link = link;
                        next.checked_at =
                            dm_gocompat::time::format_rfc3339(time::OffsetDateTime::now_utc());
                    }
                }
                changed = notable(&st.snap) != notable(&next);
                st.snap = next;
            }
            st.inflight = false;
            self.arm(&mut st);
            (
                changed,
                self.inner.opt.broadcast.clone(),
                st.on_settle.clone(),
            )
        };

        if changed && let Some(cast) = cast {
            cast();
        }
        if let Some(settle) = settle {
            settle();
        }
    }

    /// 확인 한 회가 끝났음을 알린다. 검사만 건다.
    #[cfg(test)]
    fn on_settle(&self, f: Broadcast) {
        self.inner.lock().on_settle = Some(f);
    }
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 지금 실제로 확인이 도는가다. 환경변수로 막혔으면 거짓이다.
    fn effective(&self, st: &State) -> bool {
        st.enabled && !self.killed
    }
}

fn disarm(st: &mut State) {
    st.timer_gen = st.timer_gen.wrapping_add(1);
    if let Some(t) = st.timer.take() {
        t.abort();
    }
}

/// 화면이 달라지는 부분만 남긴 값이다 (FR-UPD-8b). 확인 시각은 뺀다.
fn notable(s: &Snapshot) -> (&str, bool, &str, bool) {
    (&s.latest, s.newer, &s.link, s.failed)
}

#[cfg(test)]
mod tests;
