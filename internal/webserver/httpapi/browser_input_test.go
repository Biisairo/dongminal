package httpapi

import (
	"net/http/httptest"
	"testing"
	"time"

	"dongminal/internal/shared/toolhub"

	"github.com/gorilla/websocket"
)

// TELEGRAM_BRIDGE_SRS FR-TGB-53: 기록이 없으면 영값, 기록하면 그 도구만 갱신한다.
func TestBrowserInputs_MarkAndLast(t *testing.T) {
	var b browserInputs
	if got := b.last("a"); !got.IsZero() {
		t.Fatalf("기록 없음: %v", got)
	}
	before := time.Now()
	b.mark("a")
	if got := b.last("a"); got.Before(before) {
		t.Fatalf("a=%v before=%v", got, before)
	}
	if got := b.last("b"); !got.IsZero() {
		t.Fatalf("다른 도구까지 갱신됐다: %v", got)
	}
}

// FR-TGB-53: 브라우저 WS 의 OpInput 은 그 도구의 입력 시각을 남긴다 (직접 배선).
func TestHandleWS_OpInputMarksBrowserInput(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	ws := mustWS(t, ts, "/ws?cols=80&rows=24")
	defer ws.Close()
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, msg, _ := ws.ReadMessage()
	toolID := string(msg[1:])
	defer pm.Delete(toolID)

	if got := srv.LastBrowserInput(toolID); !got.IsZero() {
		t.Fatalf("입력 전인데 시각이 있다: %v", got)
	}
	ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := ws.WriteMessage(websocket.BinaryMessage, []byte{toolhub.OpInput, 'x'}); err != nil {
		t.Fatalf("write input: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for srv.LastBrowserInput(toolID).IsZero() {
		if time.Now().After(deadline) {
			t.Fatal("OpInput 뒤에도 입력 시각이 없다")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
