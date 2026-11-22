//! 노드 간 통신의 오류 코드 (PEER_NETWORK_SRS FR-PNW-42, PEER_DAEMON_SRS §3.5a). 노드 포트
//! (`/edge/v1/*`)와 로컬 API(`/api/edges/*`)가 함께 쓴다. 본문은 fs 방언 `{code,message}` 다.

pub const CODE_UNAVAILABLE: &str = "edge_unavailable";
pub const CODE_CONFIG_INVALID: &str = "edge_config_invalid";
pub const CODE_PORT_CLOSED: &str = "edge_port_closed";
pub const CODE_ADDR_REQUIRED: &str = "edge_addr_required";
pub const CODE_INVITE_INVALID: &str = "edge_invite_invalid";
pub const CODE_NO_INVITE: &str = "edge_no_invite";
pub const CODE_TOKEN_INVALID: &str = "edge_token_invalid";
pub const CODE_FP_MISMATCH: &str = "edge_fingerprint_mismatch";
pub const CODE_UNREACHABLE: &str = "edge_unreachable";
pub const CODE_REJECTED: &str = "edge_rejected";
pub const CODE_NOT_FOUND: &str = "edge_not_found";
pub const CODE_NOT_EDGE: &str = "edge_not_edge";
pub const CODE_AMBIGUOUS: &str = "edge_ambiguous";
pub const CODE_RATE_LIMITED: &str = "edge_rate_limited";
pub const CODE_DAEMON_RESTART: &str = "edge_daemon_restart";
pub const CODE_ADDR_UNKNOWN: &str = "edge_addr_unknown";
pub const CODE_PEER_OUTDATED: &str = "edge_peer_outdated";
pub const CODE_ALREADY_EDGE: &str = "edge_already_edge";

/// 위 코드 전부다 (Go `Codes` 와 같은 순서).
pub const CODES: &[&str] = &[
    CODE_UNAVAILABLE,
    CODE_CONFIG_INVALID,
    CODE_PORT_CLOSED,
    CODE_ADDR_REQUIRED,
    CODE_INVITE_INVALID,
    CODE_NO_INVITE,
    CODE_TOKEN_INVALID,
    CODE_FP_MISMATCH,
    CODE_UNREACHABLE,
    CODE_REJECTED,
    CODE_NOT_FOUND,
    CODE_NOT_EDGE,
    CODE_AMBIGUOUS,
    CODE_RATE_LIMITED,
    CODE_DAEMON_RESTART,
    CODE_ADDR_UNKNOWN,
    CODE_PEER_OUTDATED,
    CODE_ALREADY_EDGE,
];
