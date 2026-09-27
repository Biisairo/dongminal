package httpapi

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"dongminal/internal/shared/browser"
)

// 다음 바이너리 프레임의 첫 JPEG 바이트. d 안에 오지 않으면 -1.
func nextFrame(t *testing.T, c *websocket.Conn, d time.Duration) int {
	t.Helper()
	c.SetReadDeadline(time.Now().Add(d))
	for {
		typ, msg, err := c.ReadMessage()
		if err != nil {
			return -1
		}
		if typ == websocket.BinaryMessage {
			n := int(msg[0])<<24 | int(msg[1])<<16 | int(msg[2])<<8 | int(msg[3])
			return int(msg[4+n])
		}
	}
}

func pushFrame(fh *fakeHost, b byte) {
	fh.sink(browser.Event{Kind: browser.EvFrame, Tab: "T", Data: []byte{b}, Info: json.RawMessage(`{}`)})
}

// TC-BRT-85 (FR-BRT-94): 확인받지 못한 프레임은 2장까지다. 확인하면 최신 프레임이 간다.
func TestBrowserStreamFrameAck(t *testing.T) {
	ts, fh, _ := browserSrv(t)
	c := dialBrowser(t, ts, "tab=T&ack=1")
	bWait(t, func() bool { return fh.opCount("watch") >= 1 })
	// FR-BRT-95: 첫 뷰어는 품질 70 에서 시작한다.
	if a := fh.lastArgs("quality"); a == nil || a["q"] != float64(browser.QualityMax) {
		t.Fatalf("첫 뷰어의 품질: %v", a)
	}
	for _, b := range []byte{1, 2} {
		pushFrame(fh, b)
		if got := nextFrame(t, c, 3*time.Second); got != int(b) {
			t.Fatalf("프레임 %d 대신 %d", b, got)
		}
	}
	// 확인 없이 3 이 나갔다면 다음에 읽는 것이 3 이다. 읽기 시간 초과는 연결을 망가뜨리므로
	// "오지 않음" 을 기다려 재지 않는다.
	pushFrame(fh, 3)
	time.Sleep(300 * time.Millisecond)
	pushFrame(fh, 4)
	c.WriteMessage(websocket.TextMessage, []byte(`{"op":"frameAck"}`))
	if got := nextFrame(t, c, 3*time.Second); got != 4 {
		t.Fatalf("확인 뒤 최신 프레임 4 대신 %d", got)
	}
	if fh.opCount("frameAck") != 0 {
		t.Fatal("frameAck 가 매니저로 갔다")
	}
}

// TC-BRT-85: `ack` 없는 뷰어(옛 판)는 확인 없이도 계속 받는다.
func TestBrowserStreamWithoutAck(t *testing.T) {
	ts, fh, _ := browserSrv(t)
	c := dialBrowser(t, ts, "tab=T")
	bWait(t, func() bool { return fh.opCount("watch") >= 1 })
	for _, b := range []byte{1, 2, 3, 4} {
		pushFrame(fh, b)
		if got := nextFrame(t, c, 3*time.Second); got != int(b) {
			t.Fatalf("프레임 %d 대신 %d", b, got)
		}
	}
}

// TC-BRT-86 (FR-BRT-95): 화질 결정.
func TestQualityCtl(t *testing.T) {
	t0 := time.Unix(1_700_000_000, 0)
	at := func(ms int) time.Time { return t0.Add(time.Duration(ms) * time.Millisecond) }
	c := newQualityCtl(t0)
	if c.q != browser.QualityMax {
		t.Fatalf("시작 품질 %d", c.q)
	}
	// 기다렸고 30장 미만 → 1초 간격으로 10씩, 40 에서 멈춘다.
	steps := []struct {
		ms     int
		waited bool
		sent   int
		want   int
	}{
		{1000, true, 20, 60},
		{1500, true, 20, 60}, // 직전 변경에서 1초가 안 됐다
		{2500, true, 20, 50},
		{3500, true, 20, 40},
		{4500, true, 20, 40},
		{5500, true, 30, 40},  // 30장이면 기다렸어도 그대로
		{9500, false, 10, 40}, // 마지막 기다림(5500)에서 5초가 안 됐다
		{10500, false, 10, 50},
		{12000, false, 10, 50}, // 직전 변경에서 5초가 안 됐다
		{15500, false, 10, 60},
		{20500, false, 10, 70},
		{25500, false, 10, 70},
	}
	for _, s := range steps {
		c.tick(at(s.ms), s.waited, s.sent)
		if c.q != s.want {
			t.Fatalf("%dms (waited=%v sent=%d): q=%d, want %d", s.ms, s.waited, s.sent, c.q, s.want)
		}
	}
}
