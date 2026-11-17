package chatsock

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"testing"
	"time"

	"dongminal/internal/shared/chatwire"
	"dongminal/internal/shared/humancmd"
)

// PEER_CHAT_SRS §3.12 — 사람 참가자의 kill·kick (TC-PCH-17).

type fakeHelper struct {
	key  ed25519.PrivateKey
	code string
	fail *humancmd.Error
	down bool
	got  []humancmd.Request
}

func newFakeHelper(t *testing.T) *fakeHelper {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return &fakeHelper{key: priv, code: "123456"}
}

func (f *fakeHelper) Info() (humancmd.Info, error) {
	if f.down {
		return humancmd.Info{}, &humancmd.Error{Code: humancmd.CodeNoHelper}
	}
	return humancmd.Info{Key: humancmd.PublicKey(f.key)}, nil
}

func (f *fakeHelper) Sign(code string, r humancmd.Request) (humancmd.Signed, error) {
	f.got = append(f.got, r)
	if f.fail != nil {
		return humancmd.Signed{}, f.fail
	}
	if code != f.code {
		return humancmd.Signed{}, &humancmd.Error{Code: humancmd.CodeBadCode}
	}
	return humancmd.Sign(f.key, humancmd.Body{ID: humancmd.NewID(), Node: r.Node, Op: r.Op, Rooms: r.Rooms, Kicks: r.Kicks, At: time.Now().UnixMilli()})
}

func userRoom(t *testing.T, h *harness) string {
	t.Helper()
	h.srv.StartUser()
	raw, werr := h.srv.UserCall(chatwire.OpCreate, json.RawMessage(`{"name":"ops","purpose":""}`))
	if werr != nil {
		t.Fatal(werr)
	}
	var rr chatwire.RoomResult
	if err := json.Unmarshal(raw, &rr); err != nil {
		t.Fatal(err)
	}
	return rr.Room.ID
}

func userState(t *testing.T, h *harness) chatwire.State {
	t.Helper()
	raw, werr := h.srv.UserCall(chatwire.OpState, nil)
	if werr != nil {
		t.Fatal(werr)
	}
	var st chatwire.State
	if err := json.Unmarshal(raw, &st); err != nil {
		t.Fatal(err)
	}
	return st
}

func TestUserKillThroughHelper(t *testing.T) {
	fh := newFakeHelper(t)
	h := newHarness(t, func(o *Options) { o.Helper = fh })
	room := userRoom(t, h)
	if _, werr := h.srv.UserCall(chatwire.OpKill, json.RawMessage(`{"rooms":["`+room+`"],"code":"000000"}`)); werr == nil || werr.Code != chatwire.CodeBadCode {
		t.Fatalf("틀린 코드 = %+v", werr)
	}
	if _, werr := h.srv.UserCall(chatwire.OpKill, json.RawMessage(`{"rooms":["`+room+`"],"code":"123456"}`)); werr != nil {
		t.Fatal(werr)
	}
	if len(fh.got) != 2 || fh.got[1].Node != h.svc.Node() || fh.got[1].Op != humancmd.OpKill {
		t.Fatalf("도우미가 받은 묶음 = %+v", fh.got)
	}
	st := userState(t, h)
	if !st.Helper {
		t.Fatal("state.helper 가 거짓이다")
	}
	for _, r := range st.Rooms {
		if r.ID == room {
			t.Fatal("강제 삭제한 방이 남았다")
		}
	}
}

func TestUserKickThroughHelper(t *testing.T) {
	fh := newFakeHelper(t)
	h := newHarness(t, func(o *Options) { o.Helper = fh })
	room := userRoom(t, h)
	cl, hello := h.agent("s1", "tool-1", "claude")
	cl.call(chatwire.OpJoin, chatwire.RoomArgs{Room: room})
	args, _ := json.Marshal(map[string]any{"kicks": []chatwire.Kick{{Room: room, Participant: hello.ID}}, "code": "123456"})
	if _, werr := h.srv.UserCall(chatwire.OpKick, args); werr != nil {
		t.Fatal(werr)
	}
	if f := cl.call(chatwire.OpSend, chatwire.SendArgs{Room: room, Text: "x"}); f.Error == nil || f.Error.Code != "not_in_room" {
		t.Fatalf("강퇴된 에이전트의 보내기 = %+v", f.Error)
	}
}

func TestUserHumanErrors(t *testing.T) {
	fh := newFakeHelper(t)
	h := newHarness(t, func(o *Options) { o.Helper = fh })
	room := userRoom(t, h)
	until := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	fh.fail = &humancmd.Error{Code: humancmd.CodeLocked, Until: until.UnixMilli()}
	_, werr := h.srv.UserCall(chatwire.OpKill, json.RawMessage(`{"rooms":["`+room+`"],"code":"123456"}`))
	if werr == nil || werr.Code != chatwire.CodeLocked {
		t.Fatalf("잠김 = %+v", werr)
	}
	if got, err := time.Parse(time.RFC3339, werr.Message); err != nil || !got.Equal(until) {
		t.Fatalf("잠김 메시지 = %q, 풀리는 시각(RFC 3339)을 기대", werr.Message)
	}
	fh.fail = nil
	if _, werr := h.srv.UserCall(chatwire.OpKill, json.RawMessage(`{"rooms":[],"code":"123456"}`)); werr == nil || werr.Code != chatwire.CodeBadRequest {
		t.Fatalf("대상 없음 = %+v", werr)
	}
	if _, werr := h.srv.UserCall(chatwire.OpKick, json.RawMessage(`{"rooms":["`+room+`"],"code":"123456"}`)); werr == nil || werr.Code != chatwire.CodeBadRequest {
		t.Fatalf("종류가 섞임 = %+v", werr)
	}
	fh.down = true
	if _, werr := h.srv.UserCall(chatwire.OpKill, json.RawMessage(`{"rooms":["`+room+`"],"code":"123456"}`)); werr == nil || werr.Code != chatwire.CodeNoHelper {
		t.Fatalf("도우미 없음 = %+v", werr)
	}
}

func TestUserHumanWithoutHelper(t *testing.T) {
	h := newHarness(t)
	room := userRoom(t, h)
	if st := userState(t, h); st.Helper {
		t.Fatal("도우미가 없는데 state.helper 가 참이다")
	}
	if _, werr := h.srv.UserCall(chatwire.OpKill, json.RawMessage(`{"rooms":["`+room+`"],"code":"123456"}`)); werr == nil || werr.Code != chatwire.CodeNoHelper {
		t.Fatalf("도우미 없음 = %+v", werr)
	}
}

// 에이전트의 MCP 연결로는 kill·kick 을 부를 수 없다.
func TestAgentCannotHuman(t *testing.T) {
	fh := newFakeHelper(t)
	h := newHarness(t, func(o *Options) { o.Helper = fh })
	room := userRoom(t, h)
	cl, _ := h.agent("s1", "tool-1", "claude")
	if f := cl.call(chatwire.OpKill, map[string]any{"rooms": []string{room}, "code": "123456"}); f.Error == nil {
		t.Fatal("에이전트가 kill 을 불렀다")
	}
	if len(fh.got) != 0 {
		t.Fatal("에이전트의 요청이 도우미에 닿았다")
	}
}
