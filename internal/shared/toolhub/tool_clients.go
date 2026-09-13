package toolhub

import (
	"dongminal/internal/shared/dmlog"

	"github.com/gorilla/websocket"
)

// AddClient registers c. Returns false when the tool has already exited; in
// that case OpExit is sent to c immediately (outside cmu) and c is left
// untouched in the caller's possession. Caller must NOT hold cmu.
func (p *Tool) AddClient(c *SafeConn) bool {
	_, ok := p.AddClientAt(c)
	return ok
}

// AddClientAt 은 클라이언트를 등록하고 **등록 시점의 스트림 오프셋**을 돌려준다
// (FR-TRS-17). 그 자리부터는 broadcast 가 나르므로, 재생은 거기서 멈춰야 한다.
func (p *Tool) AddClientAt(c *SafeConn) (int64, bool) {
	p.cmu.Lock()
	if p.exited {
		p.cmu.Unlock()
		_ = c.Send(OpExit, nil)
		dmlog.Infof(nil, "[tool %s] addClient after exit addr=%s — sent OpExit", p.ID, c.RemoteAddr())
		return 0, false
	}
	p.cls = append(p.cls, c)
	n := len(p.cls)
	off := p.stream.Offset()
	p.cmu.Unlock()
	dmlog.Infof(nil, "[tool %s] client connected addr=%s total=%d at=%d", p.ID, c.RemoteAddr(), n, off)
	return off, true
}

func (p *Tool) RemoveClient(c *SafeConn) {
	p.cmu.Lock()
	for i, v := range p.cls {
		if v == c {
			p.cls = append(p.cls[:i], p.cls[i+1:]...)
			break
		}
	}
	n := len(p.cls)
	p.cmu.Unlock()
	dmlog.Infof(nil, "[tool %s] client disconnected addr=%s remaining=%d", p.ID, c.RemoteAddr(), n)
}

// broadcast delivers msg to all currently-registered clients. It is a no-op
// once the tool has transitioned to exited. Caller must NOT hold cmu.
func (p *Tool) broadcast(msg []byte) {
	p.cmu.Lock()
	if p.exited {
		p.cmu.Unlock()
		return
	}
	snap := make([]*SafeConn, len(p.cls))
	copy(snap, p.cls)
	p.cmu.Unlock()
	p.deliver(msg, snap)
}

// deliver 는 확보된 목록에 쓴다. 쓰기는 락 밖이다 — 느린 소켓 하나가 PTY 읽기
// 루프를 멈추게 하면 안 된다.
func (p *Tool) deliver(msg []byte, snap []*SafeConn) {
	for _, c := range snap {
		if err := c.WriteMsg(websocket.BinaryMessage, msg); err != nil {
			dmlog.Errorf(nil, "[tool %s] broadcast error addr=%s: %v", p.ID, c.RemoteAddr(), err)
			p.RemoveClient(c)
			c.Close()
		}
	}
}
