package toolhub

import (
	"dongminal/internal/shared/dmlog"
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
	// cls 는 바꿀 때마다 새 슬라이스다 — 읽는 쪽(feedAndDeliver·broadcast)이 복사
	// 없이 들고 나간다 (FR-OPT-3-2).
	p.cls = append(p.cls[:len(p.cls):len(p.cls)], c)
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
			next := make([]*SafeConn, 0, len(p.cls)-1)
			p.cls = append(append(next, p.cls[:i]...), p.cls[i+1:]...)
			break
		}
	}
	n := len(p.cls)
	p.cmu.Unlock()
	dmlog.Infof(nil, "[tool %s] client disconnected addr=%s remaining=%d", p.ID, c.RemoteAddr(), n)
}

// broadcast delivers msg to all currently-registered clients. It is a no-op
// once the tool has transitioned to exited. Caller must NOT hold cmu.
// 큐에 넣는 것은 cmu 안이다 — kill 의 OpExit 뒤로 가지 않는다.
func (p *Tool) broadcast(msg []byte) {
	p.cmu.Lock()
	var dropped []*SafeConn
	if !p.exited {
		dropped = enqueueAll(msg, p.cls)
	}
	p.cmu.Unlock()
	p.removeClients(dropped)
}

// enqueueAll 은 확보된 목록의 송신 큐에 넣는다 (FR-OPT-3-1). 소켓에 쓰는 것은 각
// 연결의 송신 고루틴이다 — 느린 소켓 하나가 PTY 읽기 루프도, 같은 도구의 다른
// 클라이언트도 세우지 못한다. 넘친 연결은 Enqueue 가 닫았으므로 돌려주어 호출자가
// cmu 밖에서 목록에서 빼게 한다. msg 는 모든 연결이 읽기 전용으로 나눠 쓴다.
func enqueueAll(msg []byte, snap []*SafeConn) (dropped []*SafeConn) {
	for _, c := range snap {
		if !c.Enqueue(msg) {
			dropped = append(dropped, c)
		}
	}
	return dropped
}

func (p *Tool) removeClients(cs []*SafeConn) {
	for _, c := range cs {
		p.RemoveClient(c)
	}
}
