package apierr

// 노드 간 통신의 코드 (PEER_NETWORK_SRS FR-PNW-42). 노드 포트(`/edge/v1/*`)와 로컬
// API(`/api/edges/*`)가 함께 쓴다. 본문은 fs 방언 `{code,message}` 다 (I-7).
const (
	CodeEdgeUnavailable    = "edge_unavailable"
	CodeEdgeConfigInvalid  = "edge_config_invalid"
	CodeEdgePortClosed     = "edge_port_closed"
	CodeEdgeAddrRequired   = "edge_addr_required"
	CodeEdgeInviteInvalid  = "edge_invite_invalid"
	CodeEdgeNoInvite       = "edge_no_invite"
	CodeEdgeTokenInvalid   = "edge_token_invalid"
	CodeEdgeFPMismatch     = "edge_fingerprint_mismatch"
	CodeEdgeUnreachable    = "edge_unreachable"
	CodeEdgeRejected       = "edge_rejected"
	CodeEdgeNameTaken      = "edge_name_taken"
	CodeEdgePendingMissing = "edge_pending_not_found"
	CodeEdgeNotFound       = "edge_not_found"
	CodeEdgeRateLimited    = "edge_rate_limited"
)

var edgeCodes = []string{
	CodeEdgeUnavailable, CodeEdgeConfigInvalid, CodeEdgePortClosed, CodeEdgeAddrRequired,
	CodeEdgeInviteInvalid, CodeEdgeNoInvite, CodeEdgeTokenInvalid, CodeEdgeFPMismatch,
	CodeEdgeUnreachable, CodeEdgeRejected, CodeEdgeNameTaken, CodeEdgePendingMissing, CodeEdgeNotFound,
	CodeEdgeRateLimited,
}
