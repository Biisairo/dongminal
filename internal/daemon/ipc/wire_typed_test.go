package ipc

import (
	"bytes"
	"encoding/json"
	"testing"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-6 · FR-OPT-2-8 — 데몬이 내는 바이트.

func wireOf(t *testing.T, f func(pc *panedConn)) string {
	t.Helper()
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf), build: "b"}
	f(pc)
	return buf.String()
}

// hello 는 쓰이지 않던 tool_ids 를 싣지 않고(IPC-24), 그것을 만들려고 전경 탐침까지
// 도는 pm.List() 도 부르지 않는다(IPC-M3). 옛 서버가 보내던 server_pid 는 읽지 않는다.
func TestHelloWireGolden(t *testing.T) {
	got := wireOf(t, func(pc *panedConn) {
		pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: toolipc.MethodHello, Params: json.RawMessage(`{"server_pid":0}`)})
	})
	if want := `{"id":1,"result":{"build":"b","features":["fgtick","snapnotfound","notify","busymany","fgguard"],"version":1}}` + "\n"; got != want {
		t.Fatalf("hello 바이트\n got %s\nwant %s", got, want)
	}
}

// 서버가 말한 기능을 기억한다 (D-OPT-1). 말하지 않은 옛 서버는 아무것도 갖지 않는다.
func TestHelloRecordsServerFeatures(t *testing.T) {
	var pc *panedConn
	wireOf(t, func(c *panedConn) {
		pc = c
		c.dispatch(&toolipc.PanedRequest{ID: 1, Method: toolipc.MethodHello, Params: json.RawMessage(`{"features":["f1"]}`)})
	})
	if !pc.serverHas("f1") || pc.serverHas("f2") {
		t.Fatalf("features=%v", pc.serverFeatures)
	}
	wireOf(t, func(c *panedConn) {
		pc = c
		c.dispatch(&toolipc.PanedRequest{ID: 1, Method: toolipc.MethodHello, Params: json.RawMessage(`{"server_pid":0}`)})
	})
	if pc.serverHas("f1") {
		t.Fatal("옛 서버가 말하지 않은 기능을 가졌다고 읽었다")
	}
}

// push 바이트는 종전 map 부호화와 같다 (FR-OPT-0-3).
func TestPushWireGolden(t *testing.T) {
	cases := []struct {
		do   func(pc *panedConn)
		want string
	}{
		{func(pc *panedConn) { pc.pushOutputData("a", []byte("hi"), 9) }, `{"data":"aGk=","end":9,"event":"output","tool":"a"}`},
		// nil data 도 "" 다 — protocol.go 의 never-nil 규칙 (종전 map 부호화는 언제나 문자열).
		{func(pc *panedConn) { pc.pushOutputData("a", nil, 9) }, `{"data":"","end":9,"event":"output","tool":"a"}`},
		{func(pc *panedConn) { pc.pushExit("a", toolhub.ExitInfo{Code: -1}) }, `{"code":-1,"event":"exit","tool":"a"}`},
		{func(pc *panedConn) { pc.pushForeground("a", "vim") }, `{"event":"fg","name":"vim","tool":"a"}`},
		{func(pc *panedConn) { pc.pushSize("a", 80, 24) }, `{"cols":80,"event":"size","rows":24,"tool":"a"}`},
	}
	for _, c := range cases {
		if got := wireOf(t, c.do); got != c.want+"\n" {
			t.Errorf("push 바이트\n got %s\nwant %s", got, c.want)
		}
	}
}

// 응답 바이트: 없는 도구의 조회·빈 목록. 빈 버퍼의 data 는 null 이 아니라 "" 다.
func TestResponseWireGolden(t *testing.T) {
	cases := []struct {
		method, params, want string
	}{
		{toolipc.MethodList, `{}`, `{"id":1,"result":{"tools":null}}`},
		{toolipc.MethodBackgroundList, `{}`, `{"id":1,"result":{"background":[]}}`},
		{toolipc.MethodCwd, `{"id":"x"}`, `{"id":1,"result":{"cwd":""}}`},
		{toolipc.MethodBusy, `{"id":"x"}`, `{"id":1,"result":{"busy":false}}`},
		{toolipc.MethodSetBackground, `{"id":"x","background":true}`, `{"id":1,"result":{"ok":false}}`},
		{toolipc.MethodKill, `{"id":"x"}`, ``},
		{toolipc.MethodWrite, `{"id":"x","data":"!!"}`, `{"id":1,"error":{"code":-32602,"message":"invalid base64"}}`},
		{toolipc.MethodPaste, `{"id":"x","data":"!!"}`, `{"id":1,"error":{"code":-32602,"message":"invalid base64"}}`},
		{"bogus", `{}`, `{"id":1,"error":{"code":-32601,"message":"unknown method: bogus"}}`},
		// FR-OPT-2-5: 없는 도구의 snapshot 은 내부 오류가 아니라 "없음" 이다.
		{toolipc.MethodSnapshot, `{"id":"x"}`, `{"id":1,"error":{"code":-32011,"message":"toolhub: tool not found"}}`},
	}
	for _, c := range cases {
		got := wireOf(t, func(pc *panedConn) {
			pc.dispatch(&toolipc.PanedRequest{ID: 1, Method: c.method, Params: json.RawMessage(c.params)})
		})
		if c.want != "" && got != c.want+"\n" {
			t.Errorf("%s 바이트\n got %s\nwant %s", c.method, got, c.want)
		}
	}
}

// 빈 버퍼의 snapshot data 는 "" 다 — 종전 base64 문자열과 같다.
func TestSnapshotEmptyDataIsString(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	if err := pm.Restore("5", "R", t.TempDir(), 80, 24); err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	defer pm.Delete("5")
	var buf bytes.Buffer
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&buf)}
	res := pc.snapshot(&toolipc.PanedRequest{ID: 1, Params: json.RawMessage(`{"id":"5","since":999999}`)})
	b, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(b, []byte(`"data":null`)) {
		t.Fatalf("data 가 null 로 나갔다: %s", b)
	}
}

// C9 · PEER_NETWORK_SRS I-47: paste 의 Foreground 는 데몬이 쓰기 직전에 전경을 새로 보고
// 다르면 거절한다. 그 거절은 CodeForegroundChanged 로 나간다.
func TestPasteForegroundGuard(t *testing.T) {
	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	if err := pm.Restore("7", "R", t.TempDir(), 80, 24); err != nil {
		t.Skipf("PTY 생성 불가(환경): %v", err)
	}
	defer pm.Delete("7")
	fg := "zsh"
	t.Cleanup(toolhub.SetForegroundProbe(func(ids []string) map[string]string {
		out := map[string]string{}
		for _, id := range ids {
			out[id] = fg
		}
		return out
	}))
	pc := &panedConn{pm: pm, encoder: json.NewEncoder(&bytes.Buffer{})}
	paste := func() []byte {
		res := pc.pasteWith(&toolipc.PanedRequest{ID: 1}, toolipc.PasteParams{ID: "7", Data: []byte("hi"), Foreground: "claude"})
		b, err := json.Marshal(res)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	var refused struct {
		Error struct {
			Code int `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(paste(), &refused); err != nil || refused.Error.Code != toolipc.CodeForegroundChanged {
		t.Fatalf("셸이 전경인데 거절하지 않았다: %+v err=%v", refused, err)
	}
	fg = "claude"
	if b := paste(); bytes.Contains(b, []byte(`"error"`)) {
		t.Fatalf("전경이 맞는데 거절했다: %s", b)
	}
}
