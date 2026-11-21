// Package humancmd 는 사람 명령(강제 삭제·강퇴)의 와이어다 (PEER_CHAT_SRS §3.12). 도우미
// (`dongminal otp run`, 옛 이름 `helper run`)와 데몬이 같은 한 벌을 쓴다: 도우미 소켓의 프레임, 도우미가 서명하는
// 명령 본문, 그 서명의 확인.
package humancmd

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// 명령 종류다 (FR-PCH-70).
const (
	OpKill = "kill"
	OpKick = "kick"
)

const (
	// MaxTargets 는 묶음 하나의 대상 상한이다.
	MaxTargets = 64
	// MaxLine 은 도우미 소켓 한 줄의 상한이다.
	MaxLine = 64 << 10
	// SocketPath 는 도우미 소켓이다. root 가 만들고 설치한 사용자에게 넘긴다.
	//
	// 다른 소켓처럼 home 에서 파생하지 않고 절대 경로로 고정한다 (REFACTOR3_GO_STRUCT_SRS
	// FR-RGS-42). 도우미는 macOS LaunchDaemon 으로 도는 root 프로세스 하나이고
	// (`privhelper`, 다른 OS 는 아직 없다), 인스턴스 home 을 모른다. 그리고 home 은 사용자가
	// 쓸 수 있는 자리라 같은 계정의 에이전트가 소켓을 바꿔 끼울 수 있다 — root 만 쓰는
	// `/var/run` 이어야 서명 경계가 선다. 플랫폼 transport 의 `Endpoint(home)` 은 이 둘을
	// 만족하지 않는다.
	SocketPath = "/var/run/com.dongminal.helper.sock"
	signDomain = "dmhuman1"
	maxID      = 128
)

// 도우미 소켓의 프레임 종류다.
const (
	TypeInfo   = "info"
	TypeSign   = "sign"
	TypeSigned = "signed"
	TypeError  = "error"
)

// 오류 코드다. CodeNoHelper 는 데몬이 도우미에 닿지 못할 때 쓴다.
const (
	CodeBadCode    = "bad_code"
	CodeLocked     = "locked"
	CodeBadRequest = "bad_request"
	CodeNoHelper   = "no_helper"
	// CodeUnavailable 은 도우미가 코드를 확인했지만 비밀 파일을 쓰지 못했다는 뜻이다. 틀린 횟수에
	// 넣지 않는다 (PEER_CHAT_SRS §3.12a R-5).
	CodeUnavailable = "unavailable"
)

// Kick 은 강퇴 대상 하나다.
type Kick struct {
	Room        string `json:"room"`
	Participant string `json:"participant"`
}

// Request 는 데몬이 도우미에게 서명을 부탁하는 묶음이다.
type Request struct {
	Node  string   `json:"node"`
	Op    string   `json:"op"`
	Rooms []string `json:"rooms,omitempty"`
	Kicks []Kick   `json:"kicks,omitempty"`
}

// Valid 는 묶음의 모양을 본다: 한 종류만, 대상 1~MaxTargets 개, id 모양.
func (r Request) Valid() bool {
	if !validID(r.Node) || r.Node == "" {
		return false
	}
	switch r.Op {
	case OpKill:
		if len(r.Kicks) != 0 || len(r.Rooms) == 0 || len(r.Rooms) > MaxTargets {
			return false
		}
		for _, id := range r.Rooms {
			if id == "" || !validID(id) {
				return false
			}
		}
	case OpKick:
		if len(r.Rooms) != 0 || len(r.Kicks) == 0 || len(r.Kicks) > MaxTargets {
			return false
		}
		for _, k := range r.Kicks {
			if k.Room == "" || k.Participant == "" || !validID(k.Room) || !validID(k.Participant) {
				return false
			}
		}
	default:
		return false
	}
	return true
}

// Body 는 도우미가 서명한 명령이다. ID 는 무작위, At 은 도우미 시각(ms), Key 는 도우미 공개키다.
type Body struct {
	ID    string   `json:"id"`
	Node  string   `json:"node"`
	Op    string   `json:"op"`
	Rooms []string `json:"rooms,omitempty"`
	Kicks []Kick   `json:"kicks,omitempty"`
	At    int64    `json:"at"`
	Key   string   `json:"key"`
}

// Request 는 본문의 묶음 부분이다.
func (b Body) Request() Request {
	return Request{Node: b.Node, Op: b.Op, Rooms: b.Rooms, Kicks: b.Kicks}
}

// Signed 는 본문 원문과 도우미 서명이다.
type Signed struct {
	B json.RawMessage `json:"b"`
	S string          `json:"s"`
}

// Frame 은 도우미 소켓의 줄 하나다. Code 는 sign 에서는 사람이 넣은 코드, error 에서는 오류 코드다.
type Frame struct {
	T           string          `json:"t"`
	Code        string          `json:"code,omitempty"`
	Req         *Request        `json:"req,omitempty"`
	Key         string          `json:"key,omitempty"`
	LockedUntil int64           `json:"lockedUntil,omitempty"`
	Until       int64           `json:"until,omitempty"`
	B           json.RawMessage `json:"b,omitempty"`
	S           string          `json:"s,omitempty"`
}

// Error 는 도우미의 거절이다. Until 은 locked 일 때 풀리는 시각(ms)이다.
type Error struct {
	Code  string
	Until int64
}

func (e *Error) Error() string { return "helper: " + e.Code }

// PublicKey 는 Ed25519 공개키의 base64 다.
func PublicKey(priv ed25519.PrivateKey) string {
	pub, _ := priv.Public().(ed25519.PublicKey)
	return base64.StdEncoding.EncodeToString(pub)
}

func message(body []byte) []byte {
	return append([]byte(signDomain+"\x00"), body...)
}

// Sign 은 본문에 도우미 키를 싣고 서명한다. 묶음 전체에 서명 하나다 (FR-PCH-71).
func Sign(priv ed25519.PrivateKey, b Body) (Signed, error) {
	b.Key = PublicKey(priv)
	raw, err := json.Marshal(b)
	if err != nil {
		return Signed{}, err
	}
	return Signed{B: raw, S: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, message(raw)))}, nil
}

var errBadSigned = errors.New("humancmd: 서명이나 모양이 틀렸다")

// Open 은 본문에 실린 키로 서명을 확인하고 모양을 본다. 그 키를 믿을지는 부르는 쪽이 정한다.
func Open(s Signed) (Body, error) {
	var b Body
	if json.Unmarshal(s.B, &b) != nil {
		return Body{}, errBadSigned
	}
	pub, err := base64.StdEncoding.DecodeString(b.Key)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return Body{}, errBadSigned
	}
	// 정규 표기만 받는다. 같은 서명의 다른 표기는 본 명령 해시를 비껴간다 (§3.12a R-10).
	sig, err := base64.StdEncoding.Strict().DecodeString(s.S)
	if err != nil || len(sig) != ed25519.SignatureSize || base64.StdEncoding.EncodeToString(sig) != s.S ||
		!ed25519.Verify(pub, message(s.B), sig) {
		return Body{}, errBadSigned
	}
	if b.ID == "" || !validID(b.ID) || !b.Request().Valid() {
		return Body{}, errBadSigned
	}
	return b, nil
}

// NewID 는 무작위 16바이트 hex 다.
func NewID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func validID(s string) bool {
	if len(s) > maxID {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '-' || r == '_') {
			return false
		}
	}
	return true
}
