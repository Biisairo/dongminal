package ipc

import (
	"encoding/json"
	"sync/atomic"
	"time"

	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/handover"
)

// DAEMON_SESSION_KEEP_SRS — 보고 소켓의 교체 메서드 (FR-DSK-10·17·19).
//
// 교체 요청은 `start` 가 보낸다. `paned.sock` 은 서버가 쥐고 있어 쓸 수 없다 (D-DSK-10).

// reloadWithin 은 교체 요청 연결의 시한이다. 사전 확인(5초)과 인계 상태 쓰기를 덮는다.
const reloadWithin = 12 * time.Second

// Reloader 는 교체 요청 하나를 처리한다. 거절이면 "<사유 코드>: <설명>" 오류를 돌려준다.
// 받아들이면 commit 을 돌려준다 — 보고 소켓은 성공 답을 쓴 **뒤에** commit 을 부른다
// (FR-DSK-13 6→7). commit 은 exec 하므로 돌아오지 않을 수 있다.
type Reloader func(req handover.ReloadRequest) (commit func(), err error)

type reloaderSlot struct{ fn atomic.Pointer[Reloader] }

// SetReloader 는 교체기를 싣는다. 싣지 않은 데몬은 reload_unsupported 로 답한다 (D-DSK-7).
func (ps *PanedServer) SetReloader(r Reloader) { ps.reloader.fn.Store(&r) }

// isControl 은 교체 메서드인가다. 교체 메서드는 보고가 아니므로 옛 서버 거절을 받지 않는다.
func isControl(method string) bool {
	return method == handover.MethodHello || method == handover.MethodReload
}

// handleControl 은 교체 메서드에 답한다. commit 이 nil 이 아니면 답을 쓴 뒤에 부른다.
func (ps *PanedServer) handleControl(rq agentrec.Request) (agentrec.Reply, func()) {
	if rq.Method == handover.MethodHello {
		return agentrec.Reply{OK: true}, nil
	}
	return ps.handleReload(rq.Body)
}

// handleReload 는 교체 요청을 검사해 교체기에 넘긴다.
func (ps *PanedServer) handleReload(body json.RawMessage) (agentrec.Reply, func()) {
	if len(body) > handover.MaxRequestBytes {
		return agentrec.Reply{Error: handover.ReasonExe + ": 요청이 너무 큽니다"}, nil
	}
	fn := ps.reloader.fn.Load()
	if fn == nil {
		return agentrec.Reply{Error: handover.ReasonUnsupported + ": 이 데몬은 세션 유지 교체를 하지 않습니다"}, nil
	}
	var req handover.ReloadRequest
	if err := json.Unmarshal(body, &req); err != nil {
		return agentrec.Reply{Error: handover.ReasonExe + ": 요청을 읽지 못했습니다"}, nil
	}
	commit, err := (*fn)(req)
	if err != nil {
		return agentrec.Reply{Error: err.Error()}, nil
	}
	return agentrec.Reply{OK: true}, commit
}
