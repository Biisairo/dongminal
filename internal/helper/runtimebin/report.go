package runtimebin

import (
	"encoding/json"
	"net/http"
	"os"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/platform"
)

// AGENT_RECORD_DAEMON_SRS FR-ARD-23 — 훅 보고는 데몬의 보고 소켓에 먼저 보낸다. 데몬은
// 서버가 꺼져 있어도 기록한다 (FR-ARD-25).

// reportOK 는 소켓으로 보낸 보고의 결과다. HTTP 의 성공 응답과 같게 두어, 호출자의 결과
// 판정(`dmctl notify` 의 종료 코드)이 바뀌지 않게 한다.
var reportOK = []byte(`{"ok":true}`)

// postReport 는 보고 하나다. 보고 소켓이 없거나(직접 모드·샌드박스·옛 데몬) 실패하면
// 같은 본문을 path 의 HTTP 로 보낸다. 소켓 시도는 예산의 절반까지이고, HTTP 는 남은
// 예산을 쓴다 — 두 시도의 합이 budget 을 넘지 않는다.
func postReport(method, path string, body any, budget time.Duration) (status int, respBody []byte, err error) {
	if home := os.Getenv(dmenv.EnvHome); home != "" && budget > 0 {
		start := time.Now()
		if sendReportSocket(home, method, body, budget/2) {
			return http.StatusOK, reportOK, nil
		}
		budget = max(budget-time.Since(start), time.Millisecond)
	}
	return httpPostJSONWithin(baseURL()+path, body, budget)
}

// sendReportSocket 은 home 의 보고 소켓에 보내고 데몬이 받았는가를 돌려준다.
func sendReportSocket(home, method string, body any, within time.Duration) bool {
	raw, err := json.Marshal(body)
	if err != nil {
		return false
	}
	deadline := time.Now().Add(within)
	c, err := platform.Current().IPC.Dial(agentrec.SocketPath(home), within)
	if err != nil {
		return false
	}
	defer c.Close()
	if c.SetDeadline(deadline) != nil {
		return false
	}
	if json.NewEncoder(c).Encode(agentrec.Request{Method: method, Body: raw}) != nil {
		return false
	}
	var reply agentrec.Reply
	return json.NewDecoder(c).Decode(&reply) == nil && reply.OK
}
