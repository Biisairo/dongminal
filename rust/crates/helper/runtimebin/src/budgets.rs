//! 헬퍼(otterctl·셈·훅)가 서버·데몬을 부를 때 쓰는 시간 예산 전부다 (REFACTOR3_GO_STRUCT_SRS FR-RGS-41).

#![allow(dead_code)]

use std::time::Duration;

use otter_shared_runwait::{ACTIVITY_WAIT_DEFAULT, EXIT_SETTLE, PREAMBLE_WAIT};

/// 예산을 따로 주지 않은 요청의 상한이다.
pub(crate) const HTTP_DEFAULT_BUDGET: Duration = Duration::from_secs(10);
/// 에이전트 훅이 부르는 보고(activity·context·attention)의 예산이다 (FR-OPT-8-5).
pub(crate) const HOOK_BUDGET: Duration = Duration::from_secs(2);
/// statusLine 의 서버 보고 시한이다 (NFR-SLP-1).
pub(crate) const SL_REPORT_BUDGET: Duration = Duration::from_millis(100);

/// 서버 상한 위에 클라이언트가 얹는 여유다 (FR-OPT-10-2).
pub(crate) const CLIENT_SLACK: Duration = Duration::from_secs(10);
pub(crate) const PREAMBLE_BUDGET: Duration = PREAMBLE_WAIT.saturating_add(CLIENT_SLACK);
/// /exit 대기 뒤의 헤드리스 종료 유예·worktree 정리 (ISSUE_TREE_CLOSE_SRS FR-ITX-51).
pub(crate) const CLOSE_CLIENT_ROOM: Duration = Duration::from_secs(5 * 60);
pub(crate) const CLOSE_BUDGET: Duration = EXIT_SETTLE.saturating_add(CLOSE_CLIENT_ROOM);
/// `wait` 의 기본 예산 — 서버 기본 대기 + 여유.
pub(crate) const WAIT_DEFAULT_BUDGET: Duration = ACTIVITY_WAIT_DEFAULT.saturating_add(CLIENT_SLACK);

/// 계정 전환의 예산이다. Claude Code 의 락 셋을 각각 최대 9초 기다린다.
pub(crate) const ACCOUNT_CALL_BUDGET: Duration = Duration::from_secs(40);
/// 상대를 부르는 로컬 API(add·remove)의 예산이다. 서버의 원격 요청 시한(15초)보다 길다.
pub(crate) const EDGE_CALL_BUDGET: Duration = Duration::from_secs(20);
/// claude 셈의 실행 준비 API 예산이다.
pub(crate) const SHIM_BUDGET: Duration = Duration::from_secs(3);

/// 셈이 채팅 소켓이 열려 있는지 보는 시한이다.
pub(crate) const SHIM_CHAT_DIAL_WAIT: Duration = Duration::from_millis(300);
/// 채팅 MCP 의 소켓 연결 시한이다.
pub(crate) const CHAT_DIAL_WAIT: Duration = Duration::from_secs(1);
/// 채팅 MCP 가 데몬의 답을 기다리는 시한이다.
pub(crate) const CHAT_CALL_WAIT: Duration = Duration::from_secs(5);
/// 채팅 MCP 가 탭 이름을 서버에 묻는 시한이다.
pub(crate) const CHAT_TAB_WAIT: Duration = Duration::from_secs(1);
/// ctx-hook 이 채팅 소켓에 안 읽은 수를 묻는 예산이다.
pub(crate) const CHAT_UNREAD_WAIT: Duration = Duration::from_millis(700);

/// FR-TND-12: rename-tab 의 확인 창 · 첫 확인 간격(두 배씩 는다, FR-RGS-44).
pub(crate) const RENAME_CONFIRM_WINDOW: Duration = Duration::from_millis(1500);
pub(crate) const RENAME_CONFIRM_INTERVAL: Duration = Duration::from_millis(100);
