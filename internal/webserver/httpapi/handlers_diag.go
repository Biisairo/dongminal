package httpapi

import (
	"encoding/json"
	"net/http"
	"runtime"
	"sync/atomic"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/toolclient"
)

// `GET /api/diag` — **기계가 읽는 자리** (OBSERVABILITY_SRS 묶음 D).
//
// `/api/health` 와 겹치지 않는다. 헬스는 **어긋남을 답하는 자리**이고 사람이
// 읽는다 — 판 불일치·워크스페이스 rev·데몬 연결이 거기 있다. 이쪽은 세는 것이며
// 형식도 수명도 다르다 (`VERSION_HEALTH_SRS §6-5` 가 그 둘을 갈라 둔 근거다).
//
// ── 싣지 않는 것이 이 종단의 계약이다 (FR-OBS-13 / D-OBS-5) ──────
//
// **개별 식별 정보를 싣지 않는다.** 주소·경로·도구 이름·작업 폴더가 여기 실리면
// 그 순간부터 이 종단은 "세는 것" 이 아니라 "기록하는 것" 이 된다. 인증이 없다는
// 사실(결정 9)이 그 선을 더 굵게 만든다 — 게이트 둘을 지난 요청은 허용된
// 기기이지만, 허용된 기기라고 해서 전부를 볼 이유가 되지는 않는다.

// ── 거절 계수 ──────────────────────────────────────────────
//
// 패키지 전역인 것은 **프로세스에 서버가 하나**이기 때문이다. 게이트는 `Server`
// 가 아니라 `accessStore`·`hostAllow` 를 받는 자유 함수라, 서버를 끌어들이면
// 게이트를 쓰는 검사 전부가 서버를 세워야 한다 — 그 값이 이 수치보다 크지 않다.
//
// 그래서 검사는 **절대값이 아니라 증가**를 본다 (TC-OBS-10).
var (
	accessDenies  atomic.Int64
	requestDenies atomic.Int64
)

func countAccessDenied()  { accessDenies.Add(1) }
func countRequestDenied() { requestDenies.Add(1) }

type diagGate struct {
	Access  int64 `json:"access"`
	Request int64 `json:"request"`
}

type diagBody struct {
	Tools      int      `json:"tools"`
	WS         int64    `json:"ws"`
	Goroutines int      `json:"goroutines"`
	AllocMB    uint64   `json:"allocMB"`
	PersistErr string   `json:"persistErr"`
	Gate       diagGate `json:"gate"`
	Reconnects int64    `json:"reconnects"`
	Uptime     int64    `json:"uptime"`
	Version    string   `json:"version"`
	LogLevel   string   `json:"logLevel"`
}

func (s *Server) apiDiag(w http.ResponseWriter, r *http.Request) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)

	out := diagBody{
		Goroutines: runtime.NumGoroutine(),
		AllocMB:    ms.Alloc / (1 << 20),
		Gate:       diagGate{Access: accessDenies.Load(), Request: requestDenies.Load()},
		Version:    s.cfg.Version,
		LogLevel:   logLevelName(),
		WS:         s.wsOpen.Load(),
	}
	if !s.started.IsZero() {
		out.Uptime = int64(time.Since(s.started).Seconds())
	}
	if s.Tools != nil {
		// **수만 센다.** 목록의 내용(이름·작업 폴더)은 나가지 않는다.
		out.Tools = len(s.Tools.List())
		if pc, ok := s.Tools.(*toolclient.ToolClient); ok {
			out.Reconnects = pc.Reconnects()
		}
	}
	if s.Work != nil {
		// `GO-10` 의 짝이다. 헬스도 이 값을 내지만 거기서는 **사람에게 보이는
		// 사유**이고 여기서는 "있는가 없는가" 를 기계가 본다.
		out.PersistErr = s.Work.PersistErr()
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// logLevelName 은 지금 로그 하한이다. 진단이 이것을 싣는 이유는 신고를 받을 때
// **"그 로그가 전부인가"** 를 먼저 물어야 하기 때문이다 — `warn` 으로 띄운
// 인스턴스의 로그에 info 줄이 없는 것은 결함이 아니다.
func logLevelName() string { return dmlog.Level() }
