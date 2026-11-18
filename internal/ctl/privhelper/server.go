package privhelper

import (
	"bufio"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net"
	"time"

	"dongminal/internal/shared/humancmd"
)

const connWait = 5 * time.Second

// Server 는 도우미 소켓이다 (FR-PCH-73). 연결 하나에 요청 하나다.
type Server struct {
	sec *Secret
	// uid 는 설치한 사용자다. 시작할 때 복사해 두어 복구 코드 저장과 경합하지 않는다 (§3.12a R-4).
	uid int
	key ed25519.PrivateKey
	g   *guard
	now func() time.Time
	// peerUID 는 접속한 프로세스의 OS 사용자다. 시험이 바꾼다.
	peerUID func(net.Conn) (int, error)
}

// NewServer 는 비밀로 도우미를 세운다. save 는 쓴 복구 코드를 남긴다.
func NewServer(sec *Secret, now func() time.Time, save func(Secret) error) (*Server, error) {
	seed, err := decodeKey(sec.Key)
	if err != nil {
		return nil, err
	}
	g, err := newGuard(sec, now, save)
	if err != nil {
		return nil, err
	}
	return &Server{sec: sec, uid: sec.UID, key: ed25519.NewKeyFromSeed(seed), g: g, now: now, peerUID: peerUID}, nil
}

// Serve 는 연결을 받는다. 리스너가 닫히면 돌아온다.
func (s *Server) Serve(ln net.Listener) error {
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go s.handle(c)
	}
}

func (s *Server) handle(c net.Conn) {
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(connWait))
	if uid, err := s.peerUID(c); err != nil || uid != s.uid {
		return
	}
	sc := bufio.NewScanner(c)
	sc.Buffer(make([]byte, 0, 4096), humancmd.MaxLine)
	if !sc.Scan() {
		return
	}
	var req humancmd.Frame
	resp := humancmd.Frame{T: humancmd.TypeError, Code: humancmd.CodeBadRequest}
	if json.Unmarshal(sc.Bytes(), &req) == nil {
		resp = s.answer(req)
	}
	line, err := json.Marshal(resp)
	if err != nil {
		return
	}
	_, _ = c.Write(append(line, '\n'))
}

func (s *Server) answer(req humancmd.Frame) humancmd.Frame {
	switch req.T {
	case humancmd.TypeInfo:
		f := humancmd.Frame{T: humancmd.TypeInfo, Key: humancmd.PublicKey(s.key)}
		if u := s.g.lockedUntil(); !u.IsZero() {
			f.LockedUntil = u.UnixMilli()
		}
		return f
	case humancmd.TypeSign:
		return s.sign(req)
	}
	return humancmd.Frame{T: humancmd.TypeError, Code: humancmd.CodeBadRequest}
}

// sign 은 묶음의 모양을 먼저 본다 — 틀린 묶음은 코드를 쓰지 않는다. 코드가 맞으면 묶음 전체에
// 서명 하나를 붙인다 (FR-PCH-71).
func (s *Server) sign(req humancmd.Frame) humancmd.Frame {
	if req.Req == nil || !req.Req.Valid() {
		return humancmd.Frame{T: humancmd.TypeError, Code: humancmd.CodeBadRequest}
	}
	if err := s.g.check(req.Code); err != nil {
		var he *humancmd.Error
		if errors.As(err, &he) {
			return humancmd.Frame{T: humancmd.TypeError, Code: he.Code, Until: he.Until}
		}
		return humancmd.Frame{T: humancmd.TypeError, Code: humancmd.CodeBadCode}
	}
	r := *req.Req
	signed, err := humancmd.Sign(s.key, humancmd.Body{ID: humancmd.NewID(), Node: r.Node, Op: r.Op, Rooms: r.Rooms, Kicks: r.Kicks, At: s.now().UnixMilli()})
	if err != nil {
		return humancmd.Frame{T: humancmd.TypeError, Code: humancmd.CodeBadRequest}
	}
	return humancmd.Frame{T: humancmd.TypeSigned, B: signed.B, S: signed.S}
}
