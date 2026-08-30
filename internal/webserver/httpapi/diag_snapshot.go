package httpapi

import (
	"context"
	"log"
	"runtime"
	"time"
)

// CONNECTIVITY_RESILIENCE_SRS 묶음 B — 끊긴 순간의 기록 (FR-CNR-8~12).
//
// **왜 이것이 필요한가.** 로그에 남는 것은 온 요청뿐이다 (`server.go`
// loggingMiddlewareFor). 그래서 요청이 오지 않은 구간과, 서버가 죽은 구간과,
// 로그가 그냥 비어 있는 구간이 **기록상 구별되지 않는다** (§2.3). 사용자가
// "한번씩 안 된다" 고 말한 순간들에 대해 우리가 아는 것이 없는 이유가 그것이다.
//
// 스냅샷의 설계 목표는 §2.4 의 두 증상을 **가르는 것**이다:
//
//	로딩 중 멈춤 → TCP 는 섰는데 응답이 없다 → 서버·자원 쪽
//	연결 거부   → 경로 자체가 없다        → Tailscale·네트워크 쪽
//
// 스냅샷은 이어지는데 `reqAge` 만 크게 벌어진 구간이 있으면 **경로가 없었던
// 것**이고(요청이 아예 오지 않았다), 스냅샷이 이어지면서 `reqAge` 도 작은데
// 사용자가 못 붙었다면 **서버 쪽**이다. 스냅샷 자체가 끊겼다면 서버나 호스트가
// 멈춘 것이다. 판별자가 이 셋이다.

// DiagSnapshotEvery 는 스냅샷 주기다. 60초에 한 줄이면 하루 1,440줄로
// 로테이션에 부담이 없고, 끊김의 구간을 분 단위로 짚기에 충분하다.
const DiagSnapshotEvery = 60 * time.Second

// runDiagSnapshots 는 every 마다 스냅샷을 남긴다. ctx 가 끝나면 함께 끝난다
// (FR-CNR-12) — 서버 수명을 넘겨 살아남는 고루틴을 만들지 않는다.
func (s *Server) runDiagSnapshots(ctx context.Context, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.logDiagSnapshot()
		}
	}
}

// logDiagSnapshot 은 한 줄을 남긴다.
//
// **값이 변하지 않아도 남긴다** (FR-CNR-9). 변할 때만 남기면 조용한 구간이
// 로그에서 사라지는데, 그 조용함이 곧 우리가 찾는 증거다.
func (s *Server) logDiagSnapshot() {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	log.Printf("diag reqAge=%s wsAge=%s ws=%d tools=%d miss=%d hold=%d goroutines=%d allocMB=%d",
		ageOf(s.lastReq.Load()), ageOf(s.lastWS.Load()),
		s.wsCount(), s.toolCount(),
		s.misses.size(), s.holds.Load(),
		runtime.NumGoroutine(), mem.Alloc>>20)
}

// ageOf 는 단조 시각(나노초)을 "몇 초 전" 으로 옮긴다. 한 번도 없었으면 `-` 다 —
// 0 으로 적으면 **방금 왔다**로 읽혀, 서버가 막 떴을 때와 오래 조용한 때가
// 구별되지 않는다.
func ageOf(ns int64) string {
	if ns == 0 {
		return "-"
	}
	d := time.Since(time.Unix(0, ns))
	if d < 0 {
		d = 0
	}
	return d.Truncate(time.Second).String()
}

// toolCount 는 살아 있는 도구 수다. `List()` 는 ToolHub 인터페이스에 이미 있어
// 구현을 넓히지 않는다. 데몬 모드에서는 RPC 를 타지만 60초에 한 번이라 비용이
// 문제되지 않는다.
//
// Tools 가 없으면 -1 이고, 그것이 "셀 수 없었다" 를 뜻한다 — 0 으로 적으면
// **도구가 없다**로 읽혀 다른 사실이 된다.
func (s *Server) toolCount() int {
	if s.Tools == nil {
		return -1
	}
	return len(s.Tools.List())
}

// wsCount 는 지금 붙어 있는 WS 수다. 서버가 직접 센다 — ToolHub 는 클라이언트를
// 모르고(도구를 안다), 붙잡힌 연결(FR-CNR-2)은 도구가 없는 연결이라 어차피
// 거기서 세지지 않는다.
func (s *Server) wsCount() int { return int(s.wsOpen.Load()) }
