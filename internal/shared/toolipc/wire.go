// Package toolipc는 dongminal(웹 서버)과 dongminald(데몬) 사이 Unix socket
// RPC 의 와이어 포맷만 담는다. 서버측 구현은 internal/daemon/ipc, 클라측
// 구현은 internal/webserver/toolclient 이며, 둘은 서로를 import 하지 않고
// 이 패키지의 타입만 공유한다.
package toolipc

import "encoding/json"

type PanedRequest struct {
	ID     int64           `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type PanedResponse struct {
	ID     int64 `json:"id"`
	Result any   `json:"result"`
}

type PanedError struct {
	ID    int64       `json:"id"`
	Error PanedErrObj `json:"error"`
}

type PanedErrObj struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}
