package toolhub

import (
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// SafeConn — 브라우저 WebSocket 한 벌의 직렬화된 쓰기 창구.
//
// 여기 사는 이유는 하나다: 이 파일의 것들은 **Tool 을 모른다.** 와이어 op 코드와
// 타임아웃 상수, 그리고 "쓰기는 한 번에 하나" 라는 뮤텍스 규약이 전부다. Tool 과
// ToolManager 는 이것을 쓰지만, 이것은 그 둘의 존재를 모른다.

const (
	OpInput  byte = 0x00
	OpResize byte = 0x01
	OpOutput byte = 0x00
	OpError  byte = 0x01
	OpExit   byte = 0x02
	OpToolID byte = 0x03
)

const (
	writeWait  = 10 * time.Second
	PongWait   = 60 * time.Second
	PingPeriod = (PongWait * 9) / 10
	bufMax     = 1 << 20
)

var Upgrader = websocket.Upgrader{
	ReadBufferSize:  8192,
	WriteBufferSize: 8192,
	CheckOrigin:     func(r *http.Request) bool { return true },
}

type SafeConn struct {
	mu        sync.Mutex
	conn      *websocket.Conn
	closeOnce sync.Once
}

func NewSafeConn(c *websocket.Conn) *SafeConn { return &SafeConn{conn: c} }

func (s *SafeConn) WriteMsg(typ int, data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(writeWait))
	return s.conn.WriteMessage(typ, data)
}

func (s *SafeConn) WritePing() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conn.SetWriteDeadline(time.Now().Add(PingPeriod + writeWait))
	return s.conn.WriteMessage(websocket.PingMessage, nil)
}

// Send writes one framed message. **에러를 반환한다** — 죽은 소켓에 계속 쓰면
// 초당 수십 줄의 broken pipe 로그가 쌓이므로(실측 2026-08-25), 반복 송신하는
// 호출자는 첫 실패에서 그 구독을 접어야 한다.
func (s *SafeConn) Send(op byte, payload []byte) error {
	m := make([]byte, 1+len(payload))
	m[0] = op
	copy(m[1:], payload)
	err := s.WriteMsg(websocket.BinaryMessage, m)
	if err != nil {
		log.Printf("ws send op=0x%02x addr=%s: %v", op, s.RemoteAddr(), err)
	}
	return err
}

// Close is idempotent: sync.Once prevents double-Close panics when the
// deferred Close races with an error-path Close (e.g. readWS closing on
// read error while the WS handler's defer also fires).
func (s *SafeConn) Close() {
	s.closeOnce.Do(func() {
		s.conn.Close()
	})
}
func (s *SafeConn) RemoteAddr() string                  { return s.conn.RemoteAddr().String() }
func (s *SafeConn) SetReadLimit(l int64)                { s.conn.SetReadLimit(l) }
func (s *SafeConn) SetReadDeadline(t time.Time) error   { return s.conn.SetReadDeadline(t) }
func (s *SafeConn) SetPongHandler(h func(string) error) { s.conn.SetPongHandler(h) }
func (s *SafeConn) ReadMessage() (int, []byte, error)   { return s.conn.ReadMessage() }
