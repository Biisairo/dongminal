package httpapi

import (
	"encoding/json"
	"net/http"
	"time"

	"dongminal/internal/webserver/toolclient"
)

// VERSION_HEALTH_SRS 묶음 H — `GET /api/health`.
//
// **생존이 아니라 어긋남을 답한다.** "떠 있는가" 는 `/api/ping` 이 이미 답하고,
// 이 종단은 "지금 이 인스턴스에 무엇이 어긋나 있는가" 를 한 번에 준다. M3 의
// 나머지(손상 감지·백업 복원)가 사실을 실어 보낼 자리가 여기다 — 자리가 없으면
// 그때마다 새 종단을 만들게 된다.

// healthDaemon 은 데몬 쪽 사실이다 (FR-VHL-10).
type healthDaemon struct {
	Connected bool `json:"connected"`
	// Protocol·Build 는 **데몬이 말한 것**이다. 우리 판이 아니다.
	Protocol int    `json:"protocol"`
	Build    string `json:"build"`
	// Mismatch 는 **빌드가 서로 다를 때만** 참이다 (FR-VHL-11). 데몬이 없는
	// 구성에서는 거짓이다 — 없는 것은 어긋난 것이 아니고, 그렇게 읽으면 direct
	// 모드가 영원히 빨갛다.
	Mismatch bool `json:"mismatch"`
}

type healthWorkspace struct {
	Rev uint64 `json:"rev"`
	// LastPersistErr 는 **자리만 있다** (D-4). 채우는 것은 `GO-10`("영속 실패가
	// 성공으로 보임")이며 M3 의 뒤 묶음이다 — 자리가 먼저 있어야 그때 한 줄로
	// 끝난다. 값은 **분류 문자열**이고 원문 경로를 담지 않는다 (FR-VHL-14).
	LastPersistErr string `json:"lastPersistErr"`
}

type healthBody struct {
	Version   string          `json:"version"`
	Uptime    int64           `json:"uptime"`
	Daemon    healthDaemon    `json:"daemon"`
	Workspace healthWorkspace `json:"workspace"`
	Tools     int             `json:"tools"`
}

// apiHealth 는 이 인스턴스의 지금 상태다.
//
// **언제나 200 이다** (FR-VHL-12). 503 으로 답하면 그 뒤의 필드를 아무도 읽지
// 않고 "왜" 가 사라진다 — 상태 코드는 이유를 담지 못한다.
//
// **아무것도 고치지 않는다** (NFR-VHL-1). 이미 메모리에 있는 값을 읽을 뿐이며
// 디스크도 소켓도 새로 두드리지 않는다 (NFR-VHL-2).
func (s *Server) apiHealth(w http.ResponseWriter, r *http.Request) {
	out := healthBody{Version: s.cfg.Version, Uptime: int64(time.Since(s.started).Seconds())}

	if s.Tools != nil {
		out.Tools = len(s.Tools.List())
		// 데몬 모드의 판정은 **타입**이다 — `handlers_ws.go` 가 이미 쓰는 관례이며,
		// 두 모드를 가르는 자리를 새로 만들지 않는다.
		if pc, ok := s.Tools.(*toolclient.ToolClient); ok {
			info := pc.DaemonInfo()
			out.Daemon = healthDaemon{
				Connected: pc.Connected(),
				Protocol:  info.Protocol,
				Build:     info.Build,
				// FR-VHL-11: 빌드를 **아는데** 다를 때만 어긋남이다. 데몬이 판을
				// 말하지 않으면(옛 데몬) 빈 값이고, 그것은 "모른다" 이지 불일치가
				// 아니다 (FR-CBG-5).
				// 우리 판을 모를 때도 불일치가 아니다 — 견줄 기준이 없다.
				Mismatch: info.Build != "" && out.Version != "" && info.Build != out.Version,
			}
		}
	}
	if s.Work != nil {
		out.Workspace.Rev = s.Work.CurrentRev()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}
