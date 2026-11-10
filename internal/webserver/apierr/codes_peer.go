package apierr

// 노드 간 통신의 코드 (PEER_NETWORK_SRS FR-PNW-42). 노드 포트(`/peer/v1/*`)와 로컬
// API(`/api/peers/*`)가 함께 쓴다. 본문은 fs 방언 `{code,message}` 다 (I-7).
const (
	CodePeerUnavailable    = "peer_unavailable"
	CodePeerConfigInvalid  = "peer_config_invalid"
	CodePeerPortClosed     = "peer_port_closed"
	CodePeerAddrRequired   = "peer_addr_required"
	CodePeerInviteInvalid  = "peer_invite_invalid"
	CodePeerNoInvite       = "peer_no_invite"
	CodePeerTokenInvalid   = "peer_token_invalid"
	CodePeerFPMismatch     = "peer_fingerprint_mismatch"
	CodePeerUnreachable    = "peer_unreachable"
	CodePeerRejected       = "peer_rejected"
	CodePeerNameTaken      = "peer_name_taken"
	CodePeerPendingMissing = "peer_pending_not_found"
	CodePeerNotFound       = "peer_not_found"
	CodePeerUnknownOp      = "peer_unknown_op"
	CodePeerRateLimited    = "peer_rate_limited"
	CodePeerTargetMissing  = "peer_target_not_found"
	CodePeerTargetNotAgent = "peer_target_not_agent"
	CodePeerAgentMissing   = "peer_agent_unavailable"
	CodePeerDirNotAllowed  = "peer_dir_not_allowed"
	CodePeerNotOwner       = "peer_not_owner"
	CodePeerSpawnLimit     = "peer_spawn_limit"
	CodePeerTargetWaiting  = "peer_target_waiting"
)

var peerCodes = []string{
	CodePeerUnavailable, CodePeerConfigInvalid, CodePeerPortClosed, CodePeerAddrRequired,
	CodePeerInviteInvalid, CodePeerNoInvite, CodePeerTokenInvalid, CodePeerFPMismatch,
	CodePeerUnreachable, CodePeerRejected, CodePeerNameTaken, CodePeerPendingMissing, CodePeerNotFound,
	CodePeerUnknownOp, CodePeerRateLimited, CodePeerTargetMissing, CodePeerTargetNotAgent,
	CodePeerAgentMissing, CodePeerDirNotAllowed, CodePeerNotOwner, CodePeerSpawnLimit,
	CodePeerTargetWaiting,
}
