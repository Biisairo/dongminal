package toolclient

import (
	"dongminal/internal/shared/dmlog"

	"dongminal/internal/shared/toolipc"

	"time"
)

// 연결 감시 — 끊김을 보고 지수 백오프로 다시 붙고(FR-13), 정상 상태에서는 hello 로
// 생존을 확인한다 (FR-OPT-2-1).

// supervise watches for connection loss and reconnects with exponential
// backoff, respawning dongminald when dials keep failing (FR-13).
func (pc *ToolClient) supervise() {
	beat := time.NewTicker(pc.beat.every)
	defer beat.Stop()
	for {
		pc.mu.Lock()
		cd := pc.connDone
		pc.mu.Unlock()
	alive:
		for {
			select {
			case <-pc.closed:
				return
			case <-cd:
				break alive
			case <-beat.C:
				pc.ping()
			}
		}
		if pc.stopped.Load() {
			return
		}
		dmlog.Warnf(nil, "toolclient: connection lost, reconnecting...")
		backoff := toolReconnectBackoff
		fails := 0
		for {
			if pc.stopped.Load() {
				return
			}
			select {
			case <-pc.closed:
				return
			case <-time.After(backoff):
			}
			if err := pc.connect(); err == nil {
				pc.reconnects.Add(1)
				dmlog.Infof(nil, "toolclient: reconnected")
				pc.resyncAfterReconnect()
				pc.resyncRecords()
				pc.resyncEdge()
				pc.resyncChat()
				break
			}
			fails++
			if pc.spawnDaemon != nil && fails%toolRespawnEvery == 0 {
				dmlog.Errorf(nil, "toolclient: respawning dongminald after %d failed dials", fails)
				_ = pc.spawnDaemon()
			}
			if backoff < toolMaxBackoff {
				backoff *= 2
				if backoff > toolMaxBackoff {
					backoff = toolMaxBackoff
				}
			}
		}
	}
}

// ping 은 생존 확인이다 (FR-OPT-2-1). 시한 안에 답이 없으면 callWithin 이 연결을
// 끊고 supervisor 가 재접속한다. hello 는 모든 판의 데몬이 받는다. 인자는 접속 때와
// 같다 — 데몬은 hello 마다 서버의 기능을 다시 적는다.
//
// 진행 중인 호출이 있으면 건너뛴다 — 그 호출이 자기 시한으로 무응답을 잡는다. 옛
// 데몬은 create 를 읽기 루프 안에서 돌리므로 그동안 hello 에도 답하지 않는다.
func (pc *ToolClient) ping() {
	pc.mu.Lock()
	busy := len(pc.pending) > 0
	pc.mu.Unlock()
	if busy {
		return
	}
	_, _ = pc.callWithin(toolipc.MethodHello, toolipc.HelloParams{Features: toolipc.ServerFeatures}, pc.beat.within)
}
