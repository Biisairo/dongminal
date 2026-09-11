// Package toolipc는 dongminal(웹 서버)과 dongminald(데몬) 사이 Unix socket
// RPC 의 와이어 포맷만 담는다. 서버측 구현은 internal/daemon/ipc, 클라측
// 구현은 internal/webserver/toolclient 이며, 둘은 서로를 import 하지 않고
// 이 패키지의 타입만 공유한다.
package toolipc

import "encoding/json"

// ProtocolVersion 은 데몬 IPC 의 **문법 판**이다 (VERSION_HEALTH_SRS FR-VHL-1).
//
// **빌드 판과 다른 것이다.** 빌드는 릴리스마다 바뀌고 프로토콜은 거의 바뀌지
// 않는다 — 둘을 한 값으로 합치면 **모든 릴리스가 프로토콜 불일치로 읽힌다**
// (D-1). 그래서 `hello` 는 둘을 따로 싣는다.
//
// 이 상수가 `shared` 에 있는 이유는 데몬과 서버가 **같은 한 벌**을 봐야 하기
// 때문이다. 두 벌로 적으면 한쪽만 올라가고, 그때 불일치 판정이 스스로 거짓이 된다.
const ProtocolVersion = 1

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
