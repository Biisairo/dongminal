package toolipc

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"dongminal/internal/shared/toolhub"
)

// FR-OPT-2-6 · FR-OPT-0-3: typed 구조체가 내는 바이트는 종전의 map 이 내던 바이트와
// 같다. 옛 데몬·옛 서버와 섞여 돌아도 와이어는 그대로다.
//
// legacy 는 종전 코드가 부호화하던 map 을 그대로 옮긴 것이고, want 는 그 결과를
// 글자로 적은 골든이다 — 둘 중 하나만 있으면 map 쪽 부호화 규칙이 바뀌어도 모른다.
func TestWireGolden(t *testing.T) {
	data := []byte("hi\x1b[0m")
	b64 := base64.StdEncoding.EncodeToString(data)
	modes := toolhub.TermModes{BracketedPaste: true, MouseProtocol: 1002}
	cases := []struct {
		name   string
		typed  any
		legacy any
		want   string
	}{
		{"hello-params", HelloParams{}, map[string]interface{}{}, `{}`},
		{"hello-result", HelloResult{Build: "1.2.3", Version: ProtocolVersion},
			map[string]interface{}{"version": ProtocolVersion, "build": "1.2.3"},
			`{"build":"1.2.3","version":1}`},
		{"create-params", CreateParams{Cwd: "/tmp", Cols: 80, Rows: 24, Window: "w", Profile: "p", Command: "c", Work: "k", ExtraEnv: []string{"A=1"}},
			map[string]interface{}{"cwd": "/tmp", "cols": uint16(80), "rows": uint16(24), "window": "w", "profile": "p", "command": "c", "work": "k", "extraEnv": []string{"A=1"}},
			`{"cols":80,"command":"c","cwd":"/tmp","extraEnv":["A=1"],"profile":"p","rows":24,"window":"w","work":"k"}`},
		{"create-params-nil-env", CreateParams{},
			map[string]interface{}{"cwd": "", "cols": uint16(0), "rows": uint16(0), "window": "", "profile": "", "command": "", "work": "", "extraEnv": []string(nil)},
			`{"cols":0,"command":"","cwd":"","extraEnv":null,"profile":"","rows":0,"window":"","work":""}`},
		{"create-result", CreateResult{ID: "a", Name: "S1", PID: 42, Cols: 80, Rows: 24},
			map[string]interface{}{"id": "a", "name": "S1", "pid": 42, "cols": uint16(80), "rows": uint16(24)},
			`{"cols":80,"id":"a","name":"S1","pid":42,"rows":24}`},
		{"restore-params", RestoreParams{ID: "a", Name: "R", Cwd: "/h", Cols: 100, Rows: 30},
			map[string]interface{}{"id": "a", "name": "R", "cwd": "/h", "cols": uint16(100), "rows": uint16(30)},
			`{"cols":100,"cwd":"/h","id":"a","name":"R","rows":30}`},
		{"restore-result", RestoreResult{ID: "a", Cols: 100, Rows: 30},
			map[string]interface{}{"id": "a", "cols": uint16(100), "rows": uint16(30)},
			`{"cols":100,"id":"a","rows":30}`},
		{"id-params", IDParams{ID: "a"}, map[string]interface{}{"id": "a"}, `{"id":"a"}`},
		{"terminate-params", TerminateParams{ID: "a", GraceMs: 1500},
			map[string]interface{}{"id": "a", "graceMs": int64(1500)},
			`{"graceMs":1500,"id":"a"}`},
		{"write-params", WriteParams{ID: "a", Data: data},
			map[string]interface{}{"id": "a", "data": b64},
			`{"data":"` + b64 + `","id":"a"}`},
		{"write-params-empty", WriteParams{ID: "a", Data: []byte{}},
			map[string]interface{}{"id": "a", "data": ""},
			`{"data":"","id":"a"}`},
		{"paste-params", PasteParams{ID: "a", Data: data, Submit: true},
			map[string]interface{}{"id": "a", "data": b64, "submit": true},
			`{"data":"` + b64 + `","id":"a","submit":true}`},
		{"resize-params", ResizeParams{ID: "a", Cols: 90, Rows: 20},
			map[string]interface{}{"id": "a", "cols": uint16(90), "rows": uint16(20)},
			`{"cols":90,"id":"a","rows":20}`},
		{"snapshot-params", SnapshotParams{ID: "a", Since: -1},
			map[string]interface{}{"id": "a", "since": int64(-1)},
			`{"id":"a","since":-1}`},
		{"snapshot-result", SnapshotResult{Data: data, TotalBytesIn: 9, TotalBytesDrop: 1, Retained: 7, End: 9, Resumed: true, Cols: 80, Rows: 24, Modes: modes},
			map[string]interface{}{"data": b64, "totalBytesIn": int64(9), "totalBytesDrop": int64(1), "retained": 7, "end": int64(9), "resumed": true, "cols": uint16(80), "rows": uint16(24), "modes": modes},
			`{"cols":80,"data":"` + b64 + `","end":9,"modes":{"bracketedPaste":true,"mouseProtocol":1002,"mouseEncoding":0,"focusEvent":false,"altScreen":false},"resumed":true,"retained":7,"rows":24,"totalBytesDrop":1,"totalBytesIn":9}`},
		{"snapshot-result-empty", SnapshotResult{Data: []byte{}},
			map[string]interface{}{"data": "", "totalBytesIn": int64(0), "totalBytesDrop": int64(0), "retained": 0, "end": int64(0), "resumed": false, "cols": uint16(0), "rows": uint16(0), "modes": toolhub.TermModes{}},
			`{"cols":0,"data":"","end":0,"modes":{"bracketedPaste":false,"mouseProtocol":0,"mouseEncoding":0,"focusEvent":false,"altScreen":false},"resumed":false,"retained":0,"rows":0,"totalBytesDrop":0,"totalBytesIn":0}`},
		{"cwd-result", CwdResult{Cwd: "/x"}, map[string]interface{}{"cwd": "/x"}, `{"cwd":"/x"}`},
		{"busy-result", BusyResult{Busy: true}, map[string]interface{}{"busy": true}, `{"busy":true}`},
		{"setbg-params", SetBackgroundParams{ID: "a", Background: true},
			map[string]interface{}{"id": "a", "background": true},
			`{"background":true,"id":"a"}`},
		{"setbg-result", SetBackgroundResult{OK: true}, map[string]interface{}{"ok": true}, `{"ok":true}`},
		{"list-result", ListResult{Tools: []toolhub.ToolInfo{{ID: "a", Name: "S1"}}},
			map[string]interface{}{"tools": []toolhub.ToolInfo{{ID: "a", Name: "S1"}}}, ""},
		{"list-result-nil", ListResult{}, map[string]interface{}{"tools": []toolhub.ToolInfo(nil)}, `{"tools":null}`},
		{"bglist-result", BackgroundListResult{Background: []toolhub.BackgroundEntry{{ToolID: "a", Name: "S1", Cwd: "/", Since: 3}}},
			map[string]interface{}{"background": []toolhub.BackgroundEntry{{ToolID: "a", Name: "S1", Cwd: "/", Since: 3}}}, ""},
		{"output-event", OutputEvent{Event: EventOutput, Tool: "a", Data: data, End: 9},
			map[string]interface{}{"event": "output", "tool": "a", "data": b64, "end": int64(9)},
			`{"data":"` + b64 + `","end":9,"event":"output","tool":"a"}`},
		{"exit-event", ExitEvent{Event: EventExit, Tool: "a", Code: -1},
			map[string]interface{}{"event": "exit", "tool": "a", "code": -1},
			`{"code":-1,"event":"exit","tool":"a"}`},
		{"fg-event", ForegroundEvent{Event: EventForeground, Tool: "a", Name: "vim"},
			map[string]interface{}{"event": "fg", "tool": "a", "name": "vim"},
			`{"event":"fg","name":"vim","tool":"a"}`},
		{"size-event", SizeEvent{Event: EventSize, Tool: "a", Cols: 80, Rows: 24},
			map[string]interface{}{"event": "size", "tool": "a", "cols": uint16(80), "rows": uint16(24)},
			`{"cols":80,"event":"size","rows":24,"tool":"a"}`},
	}
	for _, c := range cases {
		got, err := json.Marshal(c.typed)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		old, err := json.Marshal(c.legacy)
		if err != nil {
			t.Fatalf("%s legacy: %v", c.name, err)
		}
		if string(got) != string(old) {
			t.Errorf("%s: 바이트가 달라졌다\n got %s\nwant %s", c.name, got, old)
		}
		if c.want != "" && string(got) != c.want {
			t.Errorf("%s: 골든과 다르다\n got %s\nwant %s", c.name, got, c.want)
		}
	}
}

// 기능 협상(D-OPT-1): 말하지 않은 상대는 아무것도 갖지 않는다.
func TestHasFeature(t *testing.T) {
	if HasFeature(nil, "x") {
		t.Fatal("말하지 않은 기능을 가졌다고 읽었다")
	}
	if !HasFeature([]string{"a", "x"}, "x") {
		t.Fatal("말한 기능을 못 읽었다")
	}
}
