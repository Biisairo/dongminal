package httpapi

import (
	"encoding/binary"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"dongminal/internal/shared/toolhub"
)

// V-M9-3a — 크기 통보 (`OpSize`, M9_SRS FR-M9-3).
//
// 재는 것은 둘이다. ① 접속 직후 한 번, **재생·`OpSeq` 앞에** ② 크기가 바뀌면 그
// 도구의 **모든** 클라이언트에게. ②가 요점이다 — 비소유자는 PTY 폭을 알 길이
// 없어 같은 바이트를 자기 폭으로 해석했고, 그것이 위쪽 글이 깨지던 자리다
// (SRS §2.3 M9-B3).

// sizeOf 는 `OpSize` 프레임의 cols·rows 를 읽는다 (4 바이트, 빅엔디언).
func sizeOf(t *testing.T, frame []byte) (cols, rows uint16) {
	t.Helper()
	if len(frame) != 5 {
		t.Fatalf("OpSize 프레임 길이=%d want 5", len(frame))
	}
	return binary.BigEndian.Uint16(frame[1:3]), binary.BigEndian.Uint16(frame[3:5])
}

// firstOp 은 앞선 프레임들에서 op 를 찾아 돌려준다. 없으면 nil 이다.
func firstOp(frames [][]byte, op byte) []byte {
	for _, f := range frames {
		if len(f) > 0 && f[0] == op {
			return f
		}
	}
	return nil
}

// V-M9-3a: 접속 직후 크기가 통보되고, 그것은 `OpSeq` **앞**이다.
//
// 앞이어야 하는 이유는 재생 때문이다. 재생 바이트는 PTY 폭 기준으로 쓰인
// 이스케이프를 담고 있으므로, 클라이언트가 그것을 해석하기 전에 폭이 맞아야 한다.
func TestHandleWS_SizeAnnouncedBeforeSeq(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	p, err := pm.Create("", 97, 31, toolhub.Placement{})
	if err != nil {
		t.Fatalf("create tool: %v", err)
	}
	defer pm.Delete(p.ID)
	waitForShellReady(t, func() int { blob, _ := p.Stream().Snapshot(); return len(blob) })

	ws := mustWS(t, ts, "/ws?cols=97&rows=31&tool="+p.ID)
	defer ws.Close()

	before, _ := readUntilOp(t, ws, toolhub.OpSeq)
	frame := firstOp(before, toolhub.OpSize)
	if frame == nil {
		t.Fatal("접속 직후 OpSize 가 오지 않았다 (OpSeq 앞에 있어야 한다)")
	}
	cols, rows := sizeOf(t, frame)
	if cols != 97 || rows != 31 {
		t.Errorf("통보된 크기=%dx%d want 97x31", cols, rows)
	}
	// 재생보다도 앞이다 — 재생 바이트를 해석하기 전에 폭이 맞아야 한다.
	for _, f := range before {
		if len(f) > 0 && f[0] == toolhub.OpOutput {
			t.Error("OpSize 가 재생(OpOutput) 뒤에 왔다")
			break
		}
		if len(f) > 0 && f[0] == toolhub.OpSize {
			break
		}
	}
}

// V-M9-3a: 크기가 바뀌면 **붙어 있는 모든 클라이언트**가 그것을 받는다.
//
// 하나만 받으면 고친 것이 아니다 — 어긋나는 쪽은 언제나 크기를 **보내지 않은**
// 클라이언트(비소유자)이기 때문이다 (D-M9-3).
func TestHandleWS_SizeChangeReachesEveryClient(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	p, err := pm.Create("", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatalf("create tool: %v", err)
	}
	defer pm.Delete(p.ID)
	waitForShellReady(t, func() int { blob, _ := p.Stream().Snapshot(); return len(blob) })

	// 폭이 다른 두 클라이언트. 접수한 상황이 정확히 이것이다 (모바일 + 데스크톱).
	wsOwner := mustWS(t, ts, "/ws?cols=80&rows=24&tool="+p.ID)
	defer wsOwner.Close()
	wsOther := mustWS(t, ts, "/ws?cols=44&rows=20&tool="+p.ID)
	defer wsOther.Close()
	// 둘 다 접속 직후의 프레임을 비워 둔다 — 재는 것은 그 **뒤**의 통보다.
	readUntilOp(t, wsOwner, toolhub.OpSeq)
	readUntilOp(t, wsOther, toolhub.OpSeq)

	// 소유자가 PTY 를 잡는다.
	resize := make([]byte, 5)
	resize[0] = toolhub.OpResize
	binary.BigEndian.PutUint16(resize[1:3], 133)
	binary.BigEndian.PutUint16(resize[3:5], 41)
	if err := wsOwner.WriteMessage(websocket.BinaryMessage, resize); err != nil {
		t.Fatalf("resize 전송: %v", err)
	}

	for name, ws := range map[string]*websocket.Conn{"소유자": wsOwner, "비소유자": wsOther} {
		cols, rows := readSize(t, ws, name)
		if cols != 133 || rows != 41 {
			t.Errorf("%s 가 받은 크기=%dx%d want 133x41", name, cols, rows)
		}
	}
}

// readSize 는 `OpSize` 가 올 때까지 읽는다. PTY 출력이 사이에 섞이므로 건너뛴다.
func readSize(t *testing.T, ws *websocket.Conn, who string) (cols, rows uint16) {
	t.Helper()
	ws.SetReadDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < 64; i++ {
		_, msg, err := ws.ReadMessage()
		if err != nil {
			t.Fatalf("%s read: %v", who, err)
		}
		if len(msg) > 0 && msg[0] == toolhub.OpSize {
			return sizeOf(t, msg)
		}
	}
	t.Fatalf("%s 에게 OpSize 가 오지 않았다", who)
	return 0, 0
}

// V-M9-3a: 같은 크기를 다시 보내면 통보하지 않는다.
//
// `resendWindowSizes` 가 **창 전환마다** 같은 값을 보내므로(`app-focus.js`),
// 거르지 않으면 전환마다 모든 클라이언트가 같은 프레임을 받는다.
func TestHandleWS_SizeUnchangedIsSilent(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	srv, _ := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	p, err := pm.Create("", 80, 24, toolhub.Placement{})
	if err != nil {
		t.Fatalf("create tool: %v", err)
	}
	defer pm.Delete(p.ID)
	waitForShellReady(t, func() int { blob, _ := p.Stream().Snapshot(); return len(blob) })

	ws := mustWS(t, ts, "/ws?cols=80&rows=24&tool="+p.ID)
	defer ws.Close()
	readUntilOp(t, ws, toolhub.OpSeq)

	// 지금과 **같은** 크기.
	resize := make([]byte, 5)
	resize[0] = toolhub.OpResize
	binary.BigEndian.PutUint16(resize[1:3], 80)
	binary.BigEndian.PutUint16(resize[3:5], 24)
	if err := wsWrite(ws, resize); err != nil {
		t.Fatalf("resize 전송: %v", err)
	}
	// 그 뒤 잠깐 동안 OpSize 가 없어야 한다. 출력은 와도 된다.
	ws.SetReadDeadline(time.Now().Add(700 * time.Millisecond))
	for {
		_, msg, err := ws.ReadMessage()
		if err != nil {
			return // 시한 만료 = 통보 없음 = 합격
		}
		if len(msg) > 0 && msg[0] == toolhub.OpSize {
			c, r := sizeOf(t, msg)
			t.Fatalf("바뀌지 않았는데 OpSize 가 왔다: %dx%d", c, r)
		}
	}
}

func wsWrite(ws *websocket.Conn, b []byte) error {
	return ws.WriteMessage(websocket.BinaryMessage, b)
}

// V-M9-3a: 페이로드는 cols 2 + rows 2, 빅엔디언이다. 값이 255 를 넘는 자리에서
// 바이트 순서가 뒤집히면 44 열이 11264 열이 된다.
func TestSizePayload_BigEndian(t *testing.T) {
	p := toolhub.SizePayload(300, 41)
	if len(p) != 4 {
		t.Fatalf("길이=%d want 4", len(p))
	}
	if got := binary.BigEndian.Uint16(p[0:2]); got != 300 {
		t.Errorf("cols=%d want 300", got)
	}
	if got := binary.BigEndian.Uint16(p[2:4]); got != 41 {
		t.Errorf("rows=%d want 41", got)
	}
	if p[0] != 1 || p[1] != 44 {
		t.Errorf("바이트 순서가 빅엔디언이 아니다: %v", p[:2])
	}
	_ = strconv.Itoa(0)
}
