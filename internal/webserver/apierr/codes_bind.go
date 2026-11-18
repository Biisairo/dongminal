package apierr

// 리바인드 API(`/api/server/bind`)의 코드 (HOT_REBIND_SRS FR-HRB-21·23·24·27·45).
// 본문은 fs 방언 `{code,message}` 다.
const (
	CodeBindPortInvalid  = "bind_port_invalid"
	CodeBindPortInUse    = "bind_port_in_use"
	CodeBindRebindFailed = "bind_rebind_failed"
	CodeBindBusy         = "bind_busy"
	CodeBindLocalOnly    = "bind_local_only"
	CodeBindUnavailable  = "bind_unavailable"
)

var bindCodes = []string{
	CodeBindPortInvalid, CodeBindPortInUse, CodeBindRebindFailed,
	CodeBindBusy, CodeBindLocalOnly, CodeBindUnavailable,
}
