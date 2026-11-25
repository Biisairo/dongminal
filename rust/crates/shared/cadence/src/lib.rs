//! 남는 주기 등록부 (PERF M4 설계 §3, D-58~D-63, 사용자 요구: 주기·시간 상수는 하드코딩하지 않고 한곳에).
//!
//! 서버·데몬·제어 CLI 가 시간에 맞춰 깨어나는 일의 간격을 여기 모은다. 상수마다 깨어나는 이유를
//! 문서 주석으로 적는다. 아래 표와 상수 목록이 같은지는 시험이 본다 — 상수를 더하거나 지우면 표도
//! 함께 고친다. 쓰는 crate 는 옛 이름을 `pub use` 로 다시 내보내므로 호출처는 그대로다.
//!
//! 한 모듈만 쓰는 창(debounce·cooldown 같은 것)은 그 crate 에 둔다 — 예: git 감시의
//! `GIT_KICK_DEBOUNCE`·`GIT_KICK_COOLDOWN`(`webserver/hub`). 시한(timeout)·수명(TTL)은 주기가
//! 아니므로 여기 두지 않는다.
//!
//! ## 1. 남는 주기 (설계 §1 Q8)
//!
//! 유휴에도 남기는 주기다. 이유가 있어 사건 기반으로 바꾸지 않는다.
//!
//! | 상수 | 값 | 쓰는 곳 | 설계 |
//! |---|---|---|---|
//! | `DIAG_SNAPSHOT_EVERY` | 60초 | `webserver/httpapi` 진단 스냅샷 로그 | S6 |
//! | `TOOL_HEARTBEAT_EVERY` | 15초 | `webserver/toolclient` 데몬 생존 확인 hello | S10 |
//! | `ACCESS_REFRESH_EVERY` | 60초 | `webserver/httpapi` 허용 목록 호스트명 재해석 | S8 |
//! | `LOG_CHECK_EVERY` | 60초 | `ctl/cli` 로그 크기 확인 | S11 |
//! | `HUMANCMD_HELPER_EVERY` | 30초 | `daemon/boot` 사람 명령 도우미 확인 | D5 |
//! | `UPDATE_CHECK_EVERY` | 24시간 | `shared/updatecheck` 판 확인 트리거 ③ | S14 |
//! | `MESH_PING_EVERY` | 15초 | `shared/edgemesh` 간선 ping, 연결이 있을 때만 | D4 |
//!
//! 등록부 밖에 남는 주기와 그 이유:
//!
//! - WS ping 30초(S15): 화면 쪽 값이다 — `web/js/core/constants.js` 의 `CHAN_PING_HIDDEN_MS`.
//! - Claude 계정 엔진(S12): 간격이 설정과 응답(재설정 시각)에서 정해진다. 그 바닥·유휴 값은
//!   `webserver/domain/claudeacct` 의 엔진 안에만 쓰여 그 crate 에 둔다.
//! - 텔레그램 long-poll(S13): 대기는 Bot API 서버가 붙잡는 시간이고 `webserver/domain/telegram`
//!   클라이언트만 쓴다.
//! - `stats:` 발행(S3): 간격은 구독 토픽 이름(`stats:<ms>`)이 정한다.
//!
//! ## 2. 사건 기반으로 바뀔 주기 (설계 §1, 4.6~4.11)
//!
//! 지금은 주기로 돈다. 표의 단계가 사건 기반으로 바꾸면서 상수를 지우거나 고친다.
//!
//! | 상수 | 값 | 쓰는 곳 | 설계 · 단계 |
//! |---|---|---|---|
//! | `GIT_WATCH_ROUND_EVERY` | 1초 | `webserver/hub` git 감시 회차 | S1, 4.9 |
//! | `GIT_WATCH_WORKTREE_ROUNDS` | 4회차 | `webserver/hub` 워크트리 회차 간격 | S1, 4.9 |
//! | `GIT_WATCH_BACKOFF_MAX` | 30초 | `webserver/hub` 관측 실패 뒤 건너뛰기 상한 | S1, 4.9 |
//!
//! ## 3. 사건 기반 작업의 시간 값 (설계 §1·§3)
//!
//! 사건 기반으로 바꾼 작업이 쓰는 시간 값을 이 구획에 더한다. 각 단계가 자기 값을 넣는다.
//!
//! | 상수 | 값 | 쓰는 곳 | 설계 · 단계 |
//! |---|---|---|---|
//! | `MESH_REDIAL_MIN` | 1초 | `shared/edgemesh` 다시 걸기 간격의 처음 | D4, 4.11 |
//! | `MESH_REDIAL_MAX` | 60초 | `shared/edgemesh` 다시 걸기 간격의 끝 | D4, 4.11 |
//! | `FOREGROUND_SETTLE` | 2초 | `shared/toolhub` 전경 이름 정착 창 | D1, 4.6 |
//! | `SYSSTAT_SAMPLE_EVERY` | 2초 | `webserver/domain/sysstat` 샘플러(`stats:*` 구독 동안만) | S2, 4.10 |
//! | `SYSSTAT_WARMUP_GAP` | 250밀리초 | `webserver/domain/sysstat` 구독 시작 때 예열 표본 둘의 간격 | S2, 4.10 |
//!
//! 4.11 이 사건 기반으로 바꿔 지운 주기: Run 수거 15초(S7 — 도구 종료·Run 닫기·데몬 재접속 때만),
//! LSP 유휴 정리 2분(S9 — 세션이 있을 때 `min(last_use) + IDLE_AFTER` 마감에만, 그 값은
//! `webserver/domain/lsp` 의 `IDLE_AFTER`).
//!
//! 넣을 값: git 감시 실패·넘침 뒤 회차로 물러서는 간격(S1, 4.9).

use std::time::Duration;

// ── 1. 남는 주기 (Q8) ──

/// 진단 스냅샷 한 줄을 로그에 남기는 주기다. 오래 도는 서버의 메모리·작업 수 추이를 사후에 보려면
/// 사건이 없어도 시간 축 표본이 있어야 한다. 60초에 한 줄이면 하루 1,440줄이다.
pub const DIAG_SNAPSHOT_EVERY: Duration = Duration::from_secs(60);
/// 서버가 데몬 연결에 보내는 생존 확인 hello 의 주기다 (FR-OPT-2-1). 조용한 연결이 끊긴 것을
/// 알아채려면 무엇이라도 오가야 한다.
pub const TOOL_HEARTBEAT_EVERY: Duration = Duration::from_secs(15);
/// 허용 목록의 호스트명 항목을 다시 해석하는 주기다 (FR-ACL-5). DNS 가 바뀐 것을 알려 주는
/// 사건이 없다.
pub const ACCESS_REFRESH_EVERY: Duration = Duration::from_secs(60);
/// 홈 아래 로그의 크기를 확인하는 주기다 (FR-LOG-2). 로그를 쓰는 쪽이 여럿이라 쓰기 사건을 한곳에서
/// 받을 수 없다.
pub const LOG_CHECK_EVERY: Duration = Duration::from_secs(60);
/// 데몬이 사람 명령 도우미를 묻는 간격이다 (PEER_CHAT_SRS §3.12·§3.12a R-7). 도우미가 사라진 것을
/// 알려 주는 사건이 없다.
pub const HUMANCMD_HELPER_EVERY: Duration = Duration::from_secs(30);
/// 최신 판 확인 트리거 ③ 의 주기다 (FR-UPD-2). 보조 트리거다 — 오래 켜 둔 서버도 새 판을 안다.
pub const UPDATE_CHECK_EVERY: Duration = Duration::from_secs(24 * 60 * 60);
/// 간선 연결에 ping 을 보내는 주기다 (FR-EGM-3). 조용한 간선이 끊긴 것을 알아채려면 무엇이라도
/// 오가야 한다. 연결이 하나도 없으면 돌지 않는다 (D4).
pub const MESH_PING_EVERY: Duration = Duration::from_secs(15);

// ── 2. 사건 기반으로 바뀔 주기 (4.6~4.11) ──

/// git 감시 회차의 주기다 (FR-GPO-2). 4.9 가 대상 0 정지와 파일 감시로 바꾼다.
pub const GIT_WATCH_ROUND_EVERY: Duration = Duration::from_secs(1);
/// 워크트리 `git status` 를 도는 회차 간격(회차 수)이다 (FR-GDT-3). 4.9 가 파일 감시 사건으로 바꾼다.
pub const GIT_WATCH_WORKTREE_ROUNDS: u64 = 4;
/// 일시적 관측 실패 뒤 건너뛰는 시간의 상한이다 (min(2^(n-1), 30)s). 실패한 저장소를 매 회차 다시
/// 묻지 않게 한다.
pub const GIT_WATCH_BACKOFF_MAX: Duration = Duration::from_secs(30);

// ── 3. 사건 기반 작업의 시간 값 (4.6·4.9·4.10 이 더한다) ──

/// 간선 다시 걸기 간격의 처음이다 (FR-EGM-3). 걸기에 실패한 간선만 이 간격 뒤에 다시 건다 — 간선이
/// 없거나 모두 이어져 있으면 깨어나지 않는다 (D4). 실패마다 두 배로 늘어 `MESH_REDIAL_MAX` 에서 멈춘다.
pub const MESH_REDIAL_MIN: Duration = Duration::from_secs(1);
/// 간선 다시 걸기 간격의 끝이다 (FR-EGM-3).
pub const MESH_REDIAL_MAX: Duration = Duration::from_secs(60);
/// 전경 이름의 정착 창이다 (D1, FR-TAN-7·8). 도구에 PTY 입출력이 있으면 그 뒤 이만큼 지나 전경을
/// 한 번 조회한다. 입출력이 없으면 조회하지 않는다. 계속 출력해도 창 하나에 한 번이다.
pub const FOREGROUND_SETTLE: Duration = Duration::from_secs(2);
/// 시스템 통계 샘플 주기다 (SYSTEM_STATS_SRS D-3). `stats:*` 구독이 있는 동안만 돈다 (PERF D-61).
/// CPU·메모리는 사건 없이 바뀌므로 보는 사람이 있는 동안은 시간 축으로 잰다.
pub const SYSSTAT_SAMPLE_EVERY: Duration = Duration::from_secs(2);
/// 구독이 시작될 때 예열 표본 둘 사이의 간격이다 (PERF 4.10). CPU% 는 tick 차분이라 표본이 둘
/// 있어야 나온다 — 첫 프레임이 이만큼만 기다리면 CPU 를 싣는다. 100Hz tick 이면 코어당 25 tick 이다.
pub const SYSSTAT_WARMUP_GAP: Duration = Duration::from_millis(250);

#[cfg(test)]
mod tests;
