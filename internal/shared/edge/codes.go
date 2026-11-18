package edge

// 노드 간 통신의 오류 코드 (PEER_NETWORK_SRS FR-PNW-42, PEER_DAEMON_SRS §3.5a). 노드 포트
// (`/edge/v1/*`)와 로컬 API(`/api/edges/*`)가 함께 쓴다. 본문은 fs 방언 `{code,message}` 다.
// 데몬도 이 코드를 내므로 webserver 축(apierr)이 아니라 여기에 둔다. apierr 는 이 값을 쓴다.
const (
	CodeUnavailable   = "edge_unavailable"
	CodeConfigInvalid = "edge_config_invalid"
	CodePortClosed    = "edge_port_closed"
	CodeAddrRequired  = "edge_addr_required"
	CodeInviteInvalid = "edge_invite_invalid"
	CodeNoInvite      = "edge_no_invite"
	CodeTokenInvalid  = "edge_token_invalid"
	CodeFPMismatch    = "edge_fingerprint_mismatch"
	CodeUnreachable   = "edge_unreachable"
	CodeRejected      = "edge_rejected"
	CodeNotFound      = "edge_not_found"
	// CodeNotEdge 는 간선이 아닌 지문의 요청이다. CodeAmbiguous 는 지문 앞자리가 간선 둘
	// 이상에 맞는다는 뜻이다 (EDGE_PAIRING_SRS FR-EPR-41·30).
	CodeNotEdge     = "edge_not_edge"
	CodeAmbiguous   = "edge_ambiguous"
	CodeRateLimited = "edge_rate_limited"
	// CodeDaemonRestart 는 붙은 데몬이 노드 기능을 모른다는 뜻이다 (PEER_DAEMON_SRS FR-PDM-51).
	CodeDaemonRestart = "edge_daemon_restart"
)

// Codes 는 위 코드 전부다.
var Codes = []string{
	CodeUnavailable, CodeConfigInvalid, CodePortClosed, CodeAddrRequired,
	CodeInviteInvalid, CodeNoInvite, CodeTokenInvalid, CodeFPMismatch,
	CodeUnreachable, CodeRejected, CodeNotFound, CodeNotEdge, CodeAmbiguous,
	CodeRateLimited, CodeDaemonRestart,
}
