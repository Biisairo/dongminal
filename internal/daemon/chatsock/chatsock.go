// Package chatsock 은 데몬의 채팅 소켓이다 (PEER_CHAT_SRS §3.10). MCP 연결 하나가 참가자
// 하나이고(FR-PCH-43), 훅 질의와 0건→1건 붙여넣기 알림(FR-PCH-60~63)을 중계한다. 개수와
// 글은 저장하지 않는다(NFR-PCH-1).
package chatsock

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"dongminal/internal/daemon/chat"
	"dongminal/internal/shared/chatwire"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
)

const (
	// maxLabel 은 표시 이름의 바이트 상한이다.
	maxLabel = 64
	// userTab 은 사람 참가자의 표시 이름 뒤쪽이다 (FR-PCH-46).
	userTab = "User"
	// fpShown 은 온라인 목록에 보이는 지문 앞자리 수다.
	fpShown = 12
	// helloWait 는 첫 프레임을 기다리는 시한이다.
	helloWait = 5 * time.Second
	// writeWait 는 프레임 하나를 쓰는 시한이다.
	writeWait = 2 * time.Second
	// outQueue 는 연결마다 쌓아 둘 보낼 프레임 수다. 넘치면 연결을 끊는다.
	outQueue = 1024
	// defaultCountWait 는 훅 질의에 MCP 의 답을 기다리는 시한이다.
	defaultCountWait = 500 * time.Millisecond
)

// Tools 는 데몬의 도구 계층이다. Resting 은 그 도구의 에이전트가 쉬는 중(idle·done)인가다.
type Tools interface {
	Resting(toolID string) bool
	Paste(toolID, text string) error
}

// Options 는 채팅 소켓을 세우는 값이다.
type Options struct {
	Chat  *chat.Service
	Tools Tools
	// Name 은 이 노드의 표시 이름이다. 표시 이름 `<노드>/<탭>` 의 앞쪽이다.
	Name func() string
	// CountWait 는 훅 질의에 MCP 의 답을 기다리는 시한이다. 0 이면 500ms 다.
	CountWait time.Duration
	// MaxAgents 는 에이전트 참가자 상한이다. 0 이면 노드 상한에서 사람 하나를 뺀 값이다.
	MaxAgents int
	// Helper 는 사람 명령의 도우미다. nil 이면 kill·kick 은 no_helper 다 (§3.12).
	Helper Helper
	// OnUser 는 사람 참가자에게 온 글을 넘긴다. 데몬은 사람의 글을 들지 않는다 (FR-PCH-85).
	OnUser func(m chatwire.Message)
}

// Server 는 채팅 소켓이다.
type Server struct {
	o Options

	mu       sync.Mutex
	ln       net.Listener
	byPID    map[string]*conn
	sessions map[string][]*conn
	closed   bool
	user     chat.Participant
}

type conn struct {
	c       net.Conn
	pid     string
	session string
	tool    string
	out     chan []byte
	done    chan struct{}
	once    sync.Once

	mu   sync.Mutex
	n    uint64
	asks map[uint64]chan chatwire.Frame
}

// New 는 채팅 소켓을 만든다. Listen·Serve 로 받기 시작한다.
func New(o Options) *Server {
	if o.CountWait <= 0 {
		o.CountWait = defaultCountWait
	}
	if o.MaxAgents <= 0 {
		o.MaxAgents = chat.MaxParticipants - 1
	}
	return &Server{o: o, byPID: map[string]*conn{}, sessions: map[string][]*conn{}}
}

// Listen 은 path 에 채팅 소켓을 연다. 폴더는 0700 이다.
func (s *Server) Listen(path string) error {
	transport := platform.Current().IPC
	transport.Remove(path)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	ln, err := transport.Listen(path)
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.ln = ln
	s.mu.Unlock()
	return nil
}

// Serve 는 연결을 받는다. 리스너가 닫히면 돌아온다.
func (s *Server) Serve() {
	s.mu.Lock()
	ln := s.ln
	s.mu.Unlock()
	if ln == nil {
		return
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go s.serve(c)
	}
}

// Close 는 리스너와 모든 연결을 닫는다. 연결의 참가자는 퇴장한다.
func (s *Server) Close() {
	s.mu.Lock()
	s.closed = true
	ln := s.ln
	conns := make([]*conn, 0, len(s.byPID))
	for _, c := range s.byPID {
		conns = append(conns, c)
	}
	s.mu.Unlock()
	if ln != nil {
		ln.Close()
	}
	for _, c := range conns {
		c.close()
	}
}

// Deliver 는 이 노드의 참가자에게 온 글을 그 MCP 연결로 넘긴다 (FR-PCH-54). 사람 참가자의
// 글은 OnUser 로 넘긴다.
func (s *Server) Deliver(pid string, m chat.Message) {
	wm := chatwire.Message{
		ID: m.ID, Room: m.Room, RoomKind: m.RoomKind, RoomName: m.RoomName, RoomPurpose: m.RoomPurpose,
		From: m.From, FromLabel: m.FromLabel, FromKind: m.FromKind, Node: m.Node, Text: m.Text, At: m.At.UnixMilli(),
	}
	s.mu.Lock()
	c := s.byPID[pid]
	toUser := s.user.ID != "" && pid == s.user.ID
	s.mu.Unlock()
	if toUser {
		if s.o.OnUser != nil {
			s.o.OnUser(wm)
		}
		return
	}
	if c != nil {
		c.push(chatwire.Frame{T: chatwire.TypeMsg, Msg: &wm})
	}
}

// StartUser 는 이 노드의 사람 참가자를 세운다. 노드마다 하나이며 데몬이 사는 동안 남는다
// (FR-PCH-41). 이미 있으면 그것을 돌려준다.
func (s *Server) StartUser() chat.Participant {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.user.ID == "" {
		name := ""
		if s.o.Name != nil {
			name = clean(s.o.Name())
		}
		s.user = s.o.Chat.Register(truncBytes(name+"/"+userTab, maxLabel), chat.KindUser)
	}
	return s.user
}

// UserCall 은 사람 화면의 연산 하나다 (§3.11). op 는 채팅 소켓의 call 과 같고, state 를 더한다.
func (s *Server) UserCall(op string, args json.RawMessage) (json.RawMessage, *chatwire.Error) {
	s.mu.Lock()
	me := s.user
	s.mu.Unlock()
	if me.ID == "" {
		return nil, &chatwire.Error{Code: chatwire.CodeBadRequest, Message: "사람 참가자가 없다"}
	}
	if op == chatwire.OpKill || op == chatwire.OpKick {
		return s.human(op, args)
	}
	if op == chatwire.OpState {
		st := chatwire.State{Me: chatwire.Member{ID: me.ID, Label: me.Label, Kind: me.Kind, Online: true},
			Online: onlineOf(s.o.Chat.Online()), Rooms: []chatwire.Room{}, Helper: s.o.Chat.HelperKey() != ""}
		for _, r := range s.o.Chat.Rooms(me.ID) {
			room := roomOf(r)
			room.People = membersOf(r.Members)
			st.Rooms = append(st.Rooms, room)
		}
		raw, err := json.Marshal(st)
		if err != nil {
			return nil, &chatwire.Error{Code: chatwire.CodeBadRequest, Message: err.Error()}
		}
		return raw, nil
	}
	f := s.call(me.ID, chatwire.Frame{Op: op, Args: args})
	return f.Result, f.Error
}

func (s *Server) serve(nc net.Conn) {
	sc := chatwire.NewScanner(nc)
	_ = nc.SetReadDeadline(time.Now().Add(helloWait))
	if !sc.Scan() {
		nc.Close()
		return
	}
	var first chatwire.Frame
	if json.Unmarshal(sc.Bytes(), &first) != nil {
		refuse(nc, chatwire.CodeBadRequest, "frame")
		return
	}
	switch {
	case first.T == chatwire.TypeUnread:
		s.answerUnread(nc, first.Session)
		return
	case first.T != chatwire.TypeHello || first.Session == "" || first.Tool == "":
		refuse(nc, chatwire.CodeBadRequest, "hello 에 session·tool 이 필요하다")
		return
	}
	c, err := s.admit(nc, first)
	if err != nil {
		refuse(nc, chatwire.CodeFull, err.Error())
		return
	}
	_ = nc.SetReadDeadline(time.Time{})
	go c.writeLoop()
	defer s.drop(c)
	for sc.Scan() {
		var f chatwire.Frame
		if json.Unmarshal(sc.Bytes(), &f) != nil {
			return
		}
		switch f.T {
		case chatwire.TypeCall:
			c.push(s.call(c.pid, f))
		case chatwire.TypeRise:
			s.rise(c.tool, f)
		case chatwire.TypeCount:
			c.answer(f)
		default:
			return
		}
	}
}

func refuse(nc net.Conn, code, msg string) {
	if b, err := chatwire.Encode(chatwire.Frame{T: chatwire.TypeError, Error: &chatwire.Error{Code: code, Message: msg}}); err == nil {
		_ = nc.SetWriteDeadline(time.Now().Add(writeWait))
		_, _ = nc.Write(b)
	}
	nc.Close()
}

// admit 는 참가자를 만들고 hello 답을 줄에 넣는다.
func (s *Server) admit(nc net.Conn, h chatwire.Frame) (*conn, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, fmt.Errorf("닫혔다")
	}
	if len(s.byPID) >= s.o.MaxAgents {
		return nil, fmt.Errorf("참가자 상한 %d", s.o.MaxAgents)
	}
	label := s.label(h.Tab, h.Tool)
	p := s.o.Chat.Register(label, chat.KindAgent)
	c := &conn{c: nc, pid: p.ID, session: h.Session, tool: h.Tool,
		out: make(chan []byte, outQueue), done: make(chan struct{}), asks: map[uint64]chan chatwire.Frame{}}
	s.byPID[p.ID] = c
	s.sessions[h.Session] = append(s.sessions[h.Session], c)
	c.push(chatwire.Frame{T: chatwire.TypeHello, ID: p.ID, Label: p.Label})
	return c, nil
}

// label 은 `<노드 이름>/<탭 이름>` 이다. 탭 이름이 없으면 도구 id 앞 8자다 (§3.10).
func (s *Server) label(tab, tool string) string {
	tab = strings.TrimSpace(clean(tab))
	if tab == "" {
		tab = "tool-" + truncRunes(clean(tool), 8)
	}
	// `<노드>/User` 는 사람 참가자의 이름이다. 에이전트가 그 이름으로 보이지 않게 한다.
	if strings.EqualFold(tab, userTab) {
		tab = "tab-" + tab
	}
	name := ""
	if s.o.Name != nil {
		name = clean(s.o.Name())
	}
	return truncBytes(name+"/"+tab, maxLabel)
}

func (s *Server) drop(c *conn) {
	c.close()
	s.mu.Lock()
	delete(s.byPID, c.pid)
	list := s.sessions[c.session]
	for i, x := range list {
		if x == c {
			list = append(list[:i:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(s.sessions, c.session)
	} else {
		s.sessions[c.session] = list
	}
	s.mu.Unlock()
	s.o.Chat.Unregister(c.pid)
}

// call 은 MCP 도구 호출 하나를 채팅 핵심에 넘긴다.
func (s *Server) call(pid string, f chatwire.Frame) chatwire.Frame {
	res, err := s.dispatch(pid, f.Op, f.Args)
	r := chatwire.Frame{T: chatwire.TypeReply, N: f.N}
	if err != nil {
		code := chat.ErrorCode(err)
		if code == "" {
			code = chatwire.CodeBadRequest
		}
		r.Error = &chatwire.Error{Code: code, Message: err.Error()}
		return r
	}
	raw, err := json.Marshal(res)
	if err != nil {
		r.Error = &chatwire.Error{Code: chatwire.CodeBadRequest, Message: err.Error()}
		return r
	}
	r.Result = raw
	return r
}

func (s *Server) dispatch(pid, op string, args json.RawMessage) (any, error) {
	svc := s.o.Chat
	switch op {
	case chatwire.OpOnline:
		return onlineOf(svc.Online()), nil
	case chatwire.OpRooms:
		out := chatwire.Rooms{Rooms: []chatwire.Room{}}
		for _, r := range svc.Rooms(pid) {
			out.Rooms = append(out.Rooms, roomOf(r))
		}
		return out, nil
	case chatwire.OpCreate:
		var a chatwire.CreateArgs
		if err := decode(args, &a); err != nil {
			return nil, err
		}
		return roomResult(svc.Create(pid, a.Name, a.Purpose))
	case chatwire.OpDirect:
		var a chatwire.DirectArgs
		if err := decode(args, &a); err != nil {
			return nil, err
		}
		return roomResult(svc.Direct(pid, a.Participant, a.Purpose))
	case chatwire.OpJoin:
		var a chatwire.RoomArgs
		if err := decode(args, &a); err != nil {
			return nil, err
		}
		return roomResult(svc.Join(pid, a.Room))
	case chatwire.OpLeave:
		var a chatwire.RoomArgs
		if err := decode(args, &a); err != nil {
			return nil, err
		}
		return chatwire.OK{OK: true}, svc.Leave(pid, a.Room)
	case chatwire.OpSend:
		var a chatwire.SendArgs
		if err := decode(args, &a); err != nil {
			return nil, err
		}
		return chatwire.OK{OK: true}, svc.Send(pid, a.Room, a.Text)
	}
	return nil, fmt.Errorf("모르는 op: %q", op)
}

func decode(args json.RawMessage, v any) error {
	if len(args) == 0 {
		return fmt.Errorf("args 가 없다")
	}
	return json.Unmarshal(args, v)
}

func roomResult(r chat.RoomInfo, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	return chatwire.RoomResult{Room: roomOf(r)}, nil
}

func roomOf(r chat.RoomInfo) chatwire.Room {
	return chatwire.Room{ID: r.ID, Kind: r.Kind, Name: r.Name, Purpose: r.Purpose, Creator: r.Creator,
		CreatorName: r.CreatorName, Members: len(r.Members), Joined: r.Joined}
}

func onlineOf(v chat.OnlineView) chatwire.Online {
	out := chatwire.Online{Nodes: []chatwire.Node{}, Participants: membersOf(v.Participants)}
	for _, n := range v.Nodes {
		out.Nodes = append(out.Nodes, chatwire.Node{FP: truncBytes(n.FP, fpShown), Name: n.Name, Online: n.Online, Self: n.Self})
	}
	return out
}

func membersOf(ms []chat.Member) []chatwire.Member {
	out := []chatwire.Member{}
	for _, m := range ms {
		out = append(out, chatwire.Member{ID: m.ID, Label: m.Label, Kind: m.Kind, Node: truncBytes(m.Node, fpShown), Online: m.Online})
	}
	return out
}

// rise 는 0건→1건 알림이다. 그 도구가 쉬는 중일 때만 붙여 넣는다 (FR-PCH-61~63). 붙여 넣는
// 글에는 개수만 싣는다 — 방 이름은 망의 다른 노드가 정한 값이라, 사용자 입력처럼 제출되는
// 자리에 넣지 않는다. 방 이름은 MCP 도구 결과로만 보인다 (FR-PCH-52).
func (s *Server) rise(tool string, f chatwire.Frame) {
	if s.o.Tools == nil || f.Total <= 0 || !s.o.Tools.Resting(tool) {
		return
	}
	text := fmt.Sprintf("[dongminal chat] 새 글 %d건. chat_read 로 확인한다.", f.Total)
	go func() {
		if err := s.o.Tools.Paste(tool, text); err != nil {
			dmlog.Warnf(nil, "chat: 알림을 붙여 넣지 못했다: %v", err)
		}
	}()
}

// answerUnread 는 훅 질의다. 그 세션의 가장 나중 연결에 묻고 답을 그대로 전한다 (FR-PCH-60).
func (s *Server) answerUnread(nc net.Conn, session string) {
	defer nc.Close()
	reply := chatwire.Frame{T: chatwire.TypeUnread}
	s.mu.Lock()
	var c *conn
	if list := s.sessions[session]; len(list) > 0 {
		c = list[len(list)-1]
	}
	s.mu.Unlock()
	if c != nil {
		if got, ok := c.ask(s.o.CountWait); ok {
			reply.Total = got.Total
		}
	}
	if b, err := chatwire.Encode(reply); err == nil {
		_ = nc.SetWriteDeadline(time.Now().Add(writeWait))
		_, _ = nc.Write(b)
	}
}

func (c *conn) push(f chatwire.Frame) {
	b, err := chatwire.Encode(f)
	if err != nil {
		return
	}
	select {
	case <-c.done:
	case c.out <- b:
	default:
		dmlog.Warnf(nil, "chat: MCP 연결이 밀려 끊는다 (%s)", c.pid)
		c.close()
	}
}

func (c *conn) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case b := <-c.out:
			_ = c.c.SetWriteDeadline(time.Now().Add(writeWait))
			if _, err := c.c.Write(b); err != nil {
				c.close()
				return
			}
		}
	}
}

func (c *conn) close() {
	c.once.Do(func() {
		close(c.done)
		c.c.Close()
	})
}

func (c *conn) ask(wait time.Duration) (chatwire.Frame, bool) {
	ch := make(chan chatwire.Frame, 1)
	c.mu.Lock()
	c.n++
	n := c.n
	c.asks[n] = ch
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.asks, n)
		c.mu.Unlock()
	}()
	c.push(chatwire.Frame{T: chatwire.TypeCountAsk, N: n})
	t := time.NewTimer(wait)
	defer t.Stop()
	select {
	case f := <-ch:
		return f, true
	case <-t.C:
	case <-c.done:
	}
	return chatwire.Frame{}, false
}

func (c *conn) answer(f chatwire.Frame) {
	c.mu.Lock()
	ch := c.asks[f.N]
	c.mu.Unlock()
	if ch != nil {
		select {
		case ch <- f:
		default:
		}
	}
}

// clean 은 제어 문자와 서식 문자(Cf — bidi 재정렬·zero-width)를 지운다. 표시 이름과 붙여넣기는
// 터미널에 찍힌다 (REFACTOR3_DEFECTS_SRS FR-RD3-70 — 이전: Cf 를 남겨 다른 일곱 자리와 달랐다).
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == unicode.ReplacementChar {
			return -1
		}
		return r
	}, s)
}

func truncRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func truncBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}
