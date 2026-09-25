package toolclient

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/hub"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-1 · FR-OPT-0-4 — 정상 상태의 서버→데몬 list RPC 수.
//
// 전경 티커를 도는 데몬(fgtick)에게는 전경 폴이 list 를 하나도 보내지 않는다. 그
// 기능을 말하지 않는 옛 데몬에게는 종전대로 틱마다 list 를 보낸다 — 그러지 않으면
// 옛 데몬은 전경을 영영 다시 조회하지 않는다.

// pollUnder 는 features 를 말하는 가짜 데몬에 붙은 클라이언트 위로 전경 폴을 띄우고,
// 틱을 넣는 함수와 list 횟수를 돌려준다.
func pollUnder(t *testing.T, features []string) (chan<- time.Time, *atomic.Int64) {
	t.Helper()
	lists := &atomic.Int64{}
	sock, _ := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion, "build": "b", "features": features}, func(req toolipc.PanedRequest) any {
		if req.Method == toolipc.MethodList {
			lists.Add(1)
			return toolipc.PanedResponse{ID: req.ID, Result: toolipc.ListResult{}}
		}
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(pc.Close)
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	tick := make(chan time.Time)
	hub.StartForegroundPoll(pc, stop, tick)
	return tick, lists
}

func TestFgPollNoList(t *testing.T) {
	tick, lists := pollUnder(t, []string{toolipc.FeatureForegroundTick})
	// 틱 채널은 버퍼가 없다 — k+1 번째 틱이 넘어갔다면 k 번째 틱의 일은 끝났다.
	// 마지막 한 번은 그 동기를 위한 것이다.
	for i := 0; i <= 5; i++ {
		tick <- time.Now()
	}
	if got := lists.Load(); got != 0 {
		t.Fatalf("fgtick 데몬에 틱 5회 동안 list RPC %d회 — 0 이어야 한다", got)
	}
}

// 교차 판: 새 서버 · 옛 데몬. 틱마다 list 가 1회 나간다 — 목록 캐시(listCacheTTL)가
// 지난 뒤에 다음 틱을 준다.
func TestFgPollLegacy(t *testing.T) {
	tick, lists := pollUnder(t, nil)
	for i := int64(1); i <= 3; i++ {
		tick <- time.Now()
		deadline := time.Now().Add(3 * time.Second)
		for lists.Load() < i {
			if time.Now().After(deadline) {
				t.Fatalf("틱 %d 에 list RPC 가 나가지 않았다 (%d)", i, lists.Load())
			}
			time.Sleep(5 * time.Millisecond)
		}
		time.Sleep(listCacheTTL + 50*time.Millisecond)
	}
	if got := lists.Load(); got != 3 {
		t.Fatalf("옛 데몬에 틱 3회 동안 list RPC %d회 — 3 이어야 한다", got)
	}
}

// FR-OPT-2-5: 없는 도구의 snapshot 은 ErrToolNotFound 로 건너온다 — 연결 오류와 가른다.
func TestSnapNotFound(t *testing.T) {
	sock, _ := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion}, func(req toolipc.PanedRequest) any {
		return toolipc.PanedError{ID: req.ID, Error: toolipc.PanedErrObj{Code: toolipc.CodeNotFound, Message: "toolhub: tool not found"}}
	})
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	if _, err := pc.SnapshotToolSince("x", -1); !errors.Is(err, toolhub.ErrToolNotFound) {
		t.Fatalf("err=%v — ErrToolNotFound 여야 한다", err)
	}
}

// DaemonHub 는 데몬이 말한 기능을 밖에 알린다 (D-OPT-1).
func TestHubHasFeature(t *testing.T) {
	sock, _ := rawFake(t, map[string]any{"version": toolipc.ProtocolVersion, "features": []string{toolipc.FeatureSnapshotNotFound}}, func(req toolipc.PanedRequest) any {
		return toolipc.PanedResponse{ID: req.ID, Result: struct{}{}}
	})
	pc, err := DialToolClient(sock)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer pc.Close()
	var d toolhub.DaemonHub = pc
	if !d.HasFeature(toolipc.FeatureSnapshotNotFound) || d.HasFeature(toolipc.FeatureForegroundTick) {
		t.Fatal("기능 판정이 틀리다")
	}
}
