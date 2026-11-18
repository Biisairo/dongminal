package httpapi

import (
	"net"
	"sync"
)

// connSet 은 서버가 받은 연결이다. expose 를 끄면 같은 망에서 맺은 연결을 끊어야 하는데
// (HOT_REBIND_SRS FR-HRB-32), 리스너를 닫아도 이미 맺은 연결(WebSocket 포함)은 남기 때문이다.
type connSet struct {
	mu sync.Mutex
	m  map[*trackedConn]struct{}
}

func newConnSet() *connSet { return &connSet{m: map[*trackedConn]struct{}{}} }

// track 은 연결을 집합에 넣고, 닫힐 때 빠지는 연결을 준다.
func (s *connSet) track(c net.Conn) *trackedConn {
	tc := &trackedConn{Conn: c, set: s}
	s.mu.Lock()
	s.m[tc] = struct{}{}
	s.mu.Unlock()
	return tc
}

func (s *connSet) size() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}

// revokeRemote 는 출발지가 루프백이 아닌 연결을 모두 닫는다.
func (s *connSet) revokeRemote() {
	s.mu.Lock()
	var drop []*trackedConn
	for c := range s.m {
		if !isLoopbackAddr(c.RemoteAddr().String()) {
			drop = append(drop, c)
		}
	}
	s.mu.Unlock()
	for _, c := range drop {
		_ = c.Close()
	}
}

// trackedConn 은 닫힐 때 집합에서 빠진다. 하이재크된 연결(WebSocket)도 이 값 그대로 넘어가므로
// 그쪽이 닫아도 빠진다.
type trackedConn struct {
	net.Conn
	set *connSet
}

func (c *trackedConn) Close() error {
	c.set.mu.Lock()
	delete(c.set.m, c)
	c.set.mu.Unlock()
	return c.Conn.Close()
}

// trackedListener 는 받은 연결을 집합에 넣는다.
type trackedListener struct {
	net.Listener
	set *connSet
}

func (l trackedListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return l.set.track(c), nil
}
