// Package chatwire 는 데몬의 채팅 소켓 와이어다 (PEER_CHAT_SRS §3.10). 데몬(chatsock)과
// dmctl(chat-mcp·ctx-hook)이 같은 한 벌을 쓴다. 줄 하나에 JSON 프레임 하나다.
package chatwire

import (
	"bufio"
	"encoding/json"
	"io"
	"path/filepath"

	"dongminal/internal/shared/platform"
)

// SocketFile 은 채팅 소켓 이름이다. 데몬 소켓과 같은 0700 폴더에 산다.
const SocketFile = "chat.sock"

// MaxLine 은 프레임 한 줄의 상한이다. 넘으면 연결을 끊는다.
const MaxLine = 1 << 20

// 프레임 종류.
const (
	TypeHello    = "hello"
	TypeError    = "error"
	TypeCall     = "call"
	TypeReply    = "reply"
	TypeMsg      = "msg"
	TypeRise     = "rise"
	TypeCountAsk = "count?"
	TypeCount    = "count"
	TypeUnread   = "unread"
)

// call 의 op.
const (
	OpOnline = "online"
	OpRooms  = "rooms"
	OpCreate = "create"
	OpDirect = "direct"
	OpJoin   = "join"
	OpLeave  = "leave"
	OpSend   = "send"
)

// 채팅 핵심(`chat`)의 코드 밖에서 이 와이어가 더하는 오류 코드.
const (
	CodeBadRequest        = "bad_request"
	CodeDaemonUnavailable = "daemon_unavailable"
	CodeFull              = "participants_full"
)

// SocketPath 는 home 인스턴스의 채팅 소켓 경로다.
func SocketPath(home string) string {
	return filepath.Join(filepath.Dir(platform.Current().IPC.Endpoint(home)), SocketFile)
}

// Frame 은 채팅 소켓의 프레임 하나다. 종류에 따라 쓰는 필드가 다르다(§3.10 표).
type Frame struct {
	T string `json:"t"`
	N uint64 `json:"n,omitempty"`

	// hello (MCP → 데몬): 세션 id, 도구 id, 탭 이름. unread 도 Session 을 쓴다.
	Session string `json:"session,omitempty"`
	Tool    string `json:"tool,omitempty"`
	Tab     string `json:"tab,omitempty"`
	// hello (데몬 → MCP): 참가자 id 와 표시 이름.
	ID    string `json:"id,omitempty"`
	Label string `json:"label,omitempty"`

	Op     string          `json:"op,omitempty"`
	Args   json.RawMessage `json:"args,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`

	Msg *Message `json:"msg,omitempty"`

	// rise·count·unread: 안 읽은 글 수.
	Total int         `json:"total,omitempty"`
	Rooms []RoomCount `json:"rooms,omitempty"`
}

// Error 는 실패 하나다.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// RoomCount 는 방 하나의 안 읽은 수다.
type RoomCount struct {
	Name string `json:"name"`
	N    int    `json:"n"`
}

// Message 는 데몬이 MCP 에 넘기는 글이다. 방 종류·이름·목적을 싣는다 (FR-PCH-13).
type Message struct {
	ID          string `json:"id"`
	Room        string `json:"room"`
	RoomKind    string `json:"roomKind"`
	RoomName    string `json:"roomName"`
	RoomPurpose string `json:"roomPurpose"`
	From        string `json:"from"`
	FromLabel   string `json:"fromLabel"`
	Node        string `json:"node"`
	Text        string `json:"text"`
	At          int64  `json:"at"`
}

// Node 는 온라인 목록의 노드 하나다. FP 는 지문 앞자리다.
type Node struct {
	FP     string `json:"fp"`
	Name   string `json:"name"`
	Online bool   `json:"online"`
	Self   bool   `json:"self"`
}

// Member 는 참가자 하나다.
type Member struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Kind   string `json:"kind"`
	Node   string `json:"node"`
	Online bool   `json:"online"`
}

// Online 은 online 의 결과다.
type Online struct {
	Nodes        []Node   `json:"nodes"`
	Participants []Member `json:"participants"`
}

// Room 은 방 하나의 보기다. Unread 는 MCP 가 자기 글함에서 채운다.
type Room struct {
	ID          string `json:"id"`
	Kind        string `json:"kind"`
	Name        string `json:"name,omitempty"`
	Purpose     string `json:"purpose,omitempty"`
	Creator     string `json:"creator"`
	CreatorName string `json:"creatorName"`
	Members     int    `json:"members"`
	Joined      bool   `json:"joined"`
	Unread      int    `json:"unread"`
}

// Rooms 는 rooms 의 결과다.
type Rooms struct {
	Rooms []Room `json:"rooms"`
}

// RoomResult 는 create·direct·join 의 결과다.
type RoomResult struct {
	Room Room `json:"room"`
}

// OK 는 leave·send 의 결과다.
type OK struct {
	OK bool `json:"ok"`
}

// call 의 인자.
type (
	CreateArgs struct {
		Name    string `json:"name"`
		Purpose string `json:"purpose"`
	}
	DirectArgs struct {
		Participant string `json:"participant"`
		Purpose     string `json:"purpose"`
	}
	RoomArgs struct {
		Room string `json:"room"`
	}
	SendArgs struct {
		Room string `json:"room"`
		Text string `json:"text"`
	}
)

// NewScanner 는 줄 상한을 건 프레임 읽개다.
func NewScanner(r io.Reader) *bufio.Scanner {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64<<10), MaxLine)
	return sc
}

// Encode 는 프레임 한 줄이다(끝에 줄바꿈).
func Encode(f Frame) ([]byte, error) {
	b, err := json.Marshal(f)
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}
