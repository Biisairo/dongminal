package toolhub

import (
	"dongminal/internal/shared/dmlog"
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
	// OpSeq 는 서버가 클라이언트에게 **좌표**를 통보하는 프레임이다
	// (TERMINAL_RESUME_SRS FR-TRS-6). 페이로드는 9 바이트 —
	// 오프셋 8(빅엔디언) + 전량 재생 여부 1. 이 op 를 모르는 옛 클라이언트는
	// 조용히 버린다(FR-TRS-9). 기존 op 의 뜻과 형식은 바꾸지 않는다.
	OpSeq byte = 0x04
	// OpSize 는 서버가 클라이언트에게 **PTY 의 크기**를 통보하는 프레임이다
	// (M9_SRS FR-M9-3). 페이로드는 4 바이트 — cols 2 + rows 2, 빅엔디언.
	// ① 접속 직후 재생·OpSeq 앞에 한 번, ② 크기가 바뀔 때마다 그 도구의 모든
	// 클라이언트에게. 이 op 를 모르는 옛 클라이언트는 조용히 버린다
	// (OpSeq 와 같은 규약, FR-TRS-9).
	//
	// 크기의 주인은 한 창뿐이고(FR-XDF·FR-WSL-14) 없던 것은 그 사실을
	// **나머지에게 말하는 길**이었다 — 비소유자는 PTY 폭을 알 길이 없어 같은
	// 바이트를 자기 폭으로 해석했고, 그것이 위쪽 글이 깨지던 자리다 (D-M9-3).
	OpSize byte = 0x05
	// OpReplySeat 은 서버가 클라이언트에게 **답장을 보낼 자격**을 통보하는
	// 프레임이다 (TERM_REPLY_SEAT_SRS FR-RPS-3). 페이로드는 1 바이트 —
	// 1=이 연결이 좌석의 주인, 0=아니다.
	//
	// 왜 필요한가. 앱의 질의(`ESC]11;?` 등)는 방송으로 **모든** 클라이언트에
	// 닿고, 각 xterm 은 자기에게 물은 것으로 알고 각자 답한다. 앱은 답을 하나만
	// 먹으므로 나머지가 입력 줄에 남는다 — 그것이 프롬프트에 찍힌
	// `11;rgb:…$y…` 의 정체다 (SRS §2.3).
	//
	// 이 op 를 모르는 옛 클라이언트는 조용히 버리고, 자기가 주인이라고 본다
	// (FR-RPS-9) — 그때의 동작이 종전과 같다.
	OpReplySeat byte = 0x06
)

// SizePayload 는 `OpSize` 의 4 바이트다 (FR-M9-3).
func SizePayload(cols, rows uint16) []byte {
	return []byte{byte(cols >> 8), byte(cols), byte(rows >> 8), byte(rows)}
}

const (
	writeWait  = 10 * time.Second
	PongWait   = 60 * time.Second
	PingPeriod = (PongWait * 9) / 10
	bufMax     = 1 << 20
)

// Upgrader 는 `/ws` 의 업그레이드다. 유일한 사용처가 `httpapi.handleWS` 이고,
// 그 핸들러는 **mux 안**에 있다.
//
// `CheckOrigin` 이 항상 참인 것은 그 사실 위에 선다 (REQUEST_GATE_SRS FR-RQG-11):
// 출처 판정은 `requestGate` 가 mux **바깥**에서 이미 끝냈다. 여기서 다시 보면
// 판정이 두 벌이 되고, 두 벌이면 한쪽만 고쳐진다 — 이 저장소가 그 값을 여러 번
// 치렀다.
//
// **이 값을 게이트 밖에서 쓰지 마라.** gorilla 의 기본값(nil)은 `Origin` 이 `Host`
// 와 같아야 통과시키는데, 그것을 덮어 쓴 채 게이트 없는 자리에 두면 임의의
// 웹페이지가 터미널을 얻는다(CSWSH → RCE). 그 자리가 실제로 있었고, 전제는
// "사용자가 이 서버를 띄운 채 아무 페이지나 연다" 하나였다.
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
		dmlog.Infof(nil, "ws send op=0x%02x addr=%s: %v", op, s.RemoteAddr(), err)
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
