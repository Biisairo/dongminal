package cli

import (
	"encoding/json"
	"net/http"
	"time"
)

// VERSION_HEALTH_SRS 묶음 S — 기동이 **데몬 연결까지** 기다린다 (FR-VHL-20).
//
// 종전에는 `/api/ping` 이 답하면 준비됨이었다. 그래서 "준비됨" 직후의 도구 생성이
// 실패할 수 있었다 — 서버는 떴지만 데몬 소켓에 아직 붙지 않은 창이 있다.

// healthState 는 `/api/health` 에서 기동이 쓰는 만큼이다. 전부를 담지 않는다 —
// 여기 필요한 것은 "붙었는가" 와 "판이 어긋났는가" 둘이다.
type healthState struct {
	DaemonConnected bool
	DaemonBuild     string
	ServerVersion   string
	Mismatch        bool
}

// healthTimeout 은 한 번의 조회 상한이다. 로컬 종단이므로 짧다.
const healthTimeout = 2 * time.Second

// fetchHealth 는 `/api/health` 한 번이다.
//
// **없으면 실패가 아니라 "모른다" 다.** 헬스가 없는 옛 서버에 붙을 수 있고, 그때
// 기동을 막으면 갱신 중인 인스턴스가 통째로 못 뜬다 (FR-VHL-5 와 같은 정신).
func fetchHealth(url string, timeout time.Duration) (healthState, bool) {
	c := &http.Client{Timeout: timeout}
	resp, err := c.Get(url + "/api/health")
	if err != nil {
		return healthState{}, false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return healthState{}, false
	}
	var body struct {
		Version string `json:"version"`
		Daemon  struct {
			Connected bool   `json:"connected"`
			Build     string `json:"build"`
			Mismatch  bool   `json:"mismatch"`
		} `json:"daemon"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return healthState{}, false
	}
	return healthState{
		DaemonConnected: body.Daemon.Connected,
		DaemonBuild:     body.Daemon.Build,
		ServerVersion:   body.Version,
		Mismatch:        body.Daemon.Mismatch,
	}, true
}

// waitDaemonConnected 는 데몬이 붙을 때까지의 **유한 덤 대기**다 (FR-VHL-20).
//
// 참을 주면 붙었다는 뜻이고, 그때의 판도 함께 온다. 거짓은 **실패가 아니라
// "기다릴 것이 없었다"** 이다 (FR-VHL-20a) — 데몬을 쓰지 않는 구성에서는
// `connected` 가 영원히 거짓이고, 그것을 실패로 읽으면 그 구성이 못 뜬다.
//
// 그래서 호출자는 이 거짓으로 기동을 막지 않는다. HTTP 준비는 `waitReady` 가
// 이미 **단단한 관문**으로 판정했고, 이것은 그 위의 덤이다.
func waitDaemonConnected(url string, tries int, interval time.Duration) (healthState, bool) {
	var last healthState
	for i := 0; i < tries; i++ {
		if st, ok := fetchHealth(url, healthTimeout); ok {
			last = st
			if st.DaemonConnected {
				return st, true
			}
		}
		time.Sleep(interval)
	}
	return last, false
}
