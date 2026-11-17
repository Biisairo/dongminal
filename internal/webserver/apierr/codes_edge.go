package apierr

import "dongminal/internal/shared/edge"

// 노드 간 통신의 코드 (PEER_NETWORK_SRS FR-PNW-42). 값의 주인은 `shared/edge` 다 — 데몬도
// 같은 코드를 낸다 (PEER_DAEMON_SRS §3.5a).
const (
	CodeEdgeUnavailable   = edge.CodeUnavailable
	CodeEdgeConfigInvalid = edge.CodeConfigInvalid
	CodeEdgePortClosed    = edge.CodePortClosed
	CodeEdgeAddrRequired  = edge.CodeAddrRequired
	CodeEdgeInviteInvalid = edge.CodeInviteInvalid
	CodeEdgeNoInvite      = edge.CodeNoInvite
	CodeEdgeTokenInvalid  = edge.CodeTokenInvalid
	CodeEdgeFPMismatch    = edge.CodeFPMismatch
	CodeEdgeUnreachable   = edge.CodeUnreachable
	CodeEdgeRejected      = edge.CodeRejected
	CodeEdgeNotFound      = edge.CodeNotFound
	CodeEdgeNotEdge       = edge.CodeNotEdge
	CodeEdgeAmbiguous     = edge.CodeAmbiguous
	CodeEdgeRateLimited   = edge.CodeRateLimited
	CodeEdgeDaemonRestart = edge.CodeDaemonRestart
)

var edgeCodes = edge.Codes
