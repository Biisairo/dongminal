package hub

import (
	"sync"

	"dongminal/internal/shared/toolhub"
)

// 응답 좌석 (TERM_REPLY_SEAT_SRS 묶음 A·B).
//
// **왜 서버가 이것을 드는가.** 브라우저끼리는 서로의 존재를 모른다. 같은 도구에
// 창이 둘 붙으면 앱의 질의 하나를 두 xterm 이 다 보고 **각자 답한다.** 앱은 답을
// 하나만 먹으므로 나머지는 입력 줄에 남는다 (SRS §2.2~2.3). 누가 답할지는 서로를
// 아는 쪽 — 서버 — 만 정할 수 있다 (D-1).
//
// 자리가 `hub` 인 것은 `FocusRegistry` 와 성질이 같기 때문이다 (D-4): 서버가
// 권위로 들고, 디스크에 남기지 않으며, 재시작하면 모두 풀린다.

// SeatConn 은 좌석 통보를 받을 수 있는 연결이다. `*toolhub.SafeConn` 이 이것을
// 만족한다 — 레지스트리가 그 타입 전체를 알 필요는 없다.
type SeatConn interface {
	Send(op byte, payload []byte) error
}

// ReplySeats 는 도구마다 붙은 연결을 **붙은 순서대로** 들고 있다. 좌석의 주인은
// 언제나 그 목록의 첫 번째다 (FR-RPS-1).
type ReplySeats struct {
	mu     sync.Mutex
	byTool map[string][]SeatConn
}

func NewReplySeats() *ReplySeats {
	return &ReplySeats{byTool: make(map[string][]SeatConn)}
}

// Join 은 연결을 목록 끝에 붙이고 그 도구의 **모두에게** 좌석을 다시 통보한다.
func (r *ReplySeats) Join(toolID string, c SeatConn) {
	r.mu.Lock()
	r.byTool[toolID] = append(r.byTool[toolID], c)
	snap := r.snapshot(toolID)
	r.mu.Unlock()
	notifySeats(snap)
}

// Leave 는 연결을 목록에서 빼고 남은 모두에게 다시 통보한다. 승계는 이 통보다
// (FR-RPS-5) — 주인만 골라 알리는 길을 따로 두지 않는다.
//
// 모르는 도구·연결은 아무 일도 아니다. 끊김은 순서를 보장하지 않으므로 같은
// 연결이 두 번 떨어질 수 있다.
func (r *ReplySeats) Leave(toolID string, c SeatConn) {
	r.mu.Lock()
	cls := r.byTool[toolID]
	for i, v := range cls {
		if v == c {
			cls = append(cls[:i:i], cls[i+1:]...)
			break
		}
	}
	if len(cls) == 0 {
		delete(r.byTool, toolID)
	} else {
		r.byTool[toolID] = cls
	}
	snap := r.snapshot(toolID)
	r.mu.Unlock()
	notifySeats(snap)
}

// snapshot 은 통보할 목록을 복사한다. 호출자는 락을 쥐고 있어야 한다 — 통보
// 자체는 락 **밖**에서 한다. 느린 소켓 하나가 다른 도구의 접속을 막으면 안 된다.
func (r *ReplySeats) snapshot(toolID string) []SeatConn {
	cls := r.byTool[toolID]
	out := make([]SeatConn, len(cls))
	copy(out, cls)
	return out
}

// notifySeats 는 첫 번째에게 1, 나머지에게 0 을 보낸다.
//
// 실패는 삼킨다 (FR-RPS-6). 죽은 소켓은 바로 뒤의 재생이나 방송이 다시 만나고,
// 그 연결을 끝낼지는 그쪽이 판정한다 — 여기서 끊으면 판정이 두 곳이 된다.
func notifySeats(cls []SeatConn) {
	for i, c := range cls {
		var owns byte
		if i == 0 {
			owns = 1
		}
		_ = c.Send(toolhub.OpReplySeat, []byte{owns})
	}
}
