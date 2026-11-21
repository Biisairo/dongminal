package telegram

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

// REFACTOR3_DEFECTS_SRS TC-RD3-40: 작업자가 Telegram 응답을 기다리는 동안 polling 이 멈추지 않는다.
// 이전에는 작업자가 b.mu 를 쥔 채 HTTP 를 불러 handleUpdate 가 그 잠금을 기다렸다.
func TestBridge_HTTPOutsideLock(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
		_, _ = io.WriteString(w, `{"ok":true,"result":{"message_id":1}}`)
	}))
	defer srv.Close()
	defer close(release)
	st := OpenStore(filepath.Join(t.TempDir(), "telegram.json"))
	_ = st.SetToken(testToken, "office_bot")
	_ = st.SetUser(me)
	_ = st.SetEnabled(true)
	b := NewBridge(st, &fakeHost{lastIn: map[string]time.Time{}}, srv.URL, time.Now)

	go b.process(item{attnTool: tabA, attnReason: "done"})
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("작업자가 HTTP 에 닿지 않았다")
	}
	done := make(chan struct{})
	go func() {
		// 등록되지 않은 사람의 글 — HTTP 없이 끝나는 갈래다.
		b.handleUpdate(Update{Message: &Message{From: &User{ID: me + 1}, Chat: Chat{ID: me + 1}, Text: "hi"}})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("작업자의 HTTP 가 끝날 때까지 handleUpdate 가 막혔다")
	}
}

// TC-RD3-41: 탭 하나의 [읽음] 버튼 목록은 maxButtonsPerTab 를 넘지 않는다.
func TestBridge_ButtonsCapped(t *testing.T) {
	r := newRig(t)
	for i := 0; i < maxButtonsPerTab+8; i++ {
		r.attn(tabA, "done")
	}
	r.b.mu.Lock()
	n := len(r.b.buttons[tabA])
	r.b.mu.Unlock()
	if n != maxButtonsPerTab {
		t.Fatalf("버튼 %d개 want %d", n, maxButtonsPerTab)
	}
}
