package agentadapter

import (
	"encoding/json"
	"testing"
)

// M12_SRS FR-M12-1~3 (V-M12-1·2·4·6) — **도구가 무엇을 했는지는 어댑터가 말한다.**
//
// 종전에는 브라우저가 `command`·`file_path`·`old_string`·`run_in_background` 라는
// **claude 의 입력 키를 알았다** (누수 L1·L3·L4). 더 나쁜 것은 그 앎이 claude 에만
// 맞아서, codex·omp 의 도구 카드에는 **인자가 아예 서지 않았다** (L2).
//
// 여기서 재는 것은 셋 모두가 **같은 어휘로** 말하는가다.

// toolBlocks 는 EvMessage 의 `tool_use` 블록들을 꺼낸다 — 공통 어휘 그대로.
type toolBlock struct {
	Type       string          `json:"type"`
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Input      json.RawMessage `json:"input"`
	Detail     string          `json:"detail"`
	Edit       *ToolEdit       `json:"edit"`
	Background bool            `json:"background"`
}

func toolBlocksOf(t *testing.T, evs []Event) []toolBlock {
	t.Helper()
	var out []toolBlock
	for _, e := range evs {
		if e.Kind != EvMessage || len(e.Message) == 0 {
			continue
		}
		var bs []toolBlock
		if err := json.Unmarshal(e.Message, &bs); err != nil {
			t.Fatalf("블록을 읽을 수 없다: %v (%s)", err, e.Message)
		}
		for _, b := range bs {
			if b.Type == "tool_use" {
				out = append(out, b)
			}
		}
	}
	return out
}

func toolStartOf(t *testing.T, evs []Event) Event {
	t.Helper()
	for _, e := range evs {
		if e.Kind == EvToolStart {
			return e
		}
	}
	t.Fatalf("tool_start 가 없다: %s", kinds(evs))
	return Event{}
}

// V-M12-1·2: claude 는 인자가 **늦게 온다** — `content_block_start` 의 `input` 이
// 비어 있고 실제 인자는 뒤의 스냅샷에 실린다 (실측 M11_SRS §2.11). 그래서 claude 의
// 임자는 **블록**이다.
func TestClaudeProto_ToolViewOnBlocks(t *testing.T) {
	cases := []struct {
		name       string
		tool       string
		input      string
		wantDetail string
	}{
		{"Bash 는 명령", "Bash", `{"command":"touch fake.txt","description":"Create"}`, "touch fake.txt"},
		{"Edit 는 경로", "Edit", `{"file_path":"/w/a.txt","old_string":"a","new_string":"b"}`, "/w/a.txt"},
		{"Read 도 경로", "Read", `{"file_path":"/w/b.txt"}`, "/w/b.txt"},
		// **화면판(`agentDetail`)은 이것을 몰랐다** — 어댑터판이 더 잘 안다.
		{"Grep 은 패턴", "Grep", `{"pattern":"foo.*bar","path":"/w"}`, "foo.*bar"},
		{"Glob 도 패턴", "Glob", `{"pattern":"**/*.go"}`, "**/*.go"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p, st := protoOf(t)
			evs := decode1(t, p, st, `{"type":"assistant","session_id":"`+claudeSID+`","message":{"role":"assistant","content":[`+
				`{"type":"tool_use","id":"tu-1","name":"`+c.tool+`","input":`+c.input+`}]}}`)
			bs := toolBlocksOf(t, evs)
			if len(bs) != 1 {
				t.Fatalf("tool_use 블록 하나여야 한다: %d", len(bs))
			}
			if bs[0].Detail != c.wantDetail {
				t.Errorf("detail=%q, 기대 %q", bs[0].Detail, c.wantDetail)
			}
			// **입력 원문은 그대로 간다** — 승인 다이얼로그와 카드 본문이 그것을 보인다.
			if len(bs[0].Input) == 0 {
				t.Error("input 원문이 사라졌다 — 바뀐 것은 뽑아 쓰는 자리이지 계약이 아니다")
			}
		})
	}
}

// V-M12-2: 모르는 도구는 **입력 JSON 이 detail 이다.** 종전에 화면의 `agentDetail` 이
// 마지막 갈래로 하던 일이며, 그 모양을 잃지 않으려면 어댑터가 같은 일을 해야 한다.
func TestClaudeProto_ToolViewUnknownTool(t *testing.T) {
	p, st := protoOf(t)
	evs := decode1(t, p, st, `{"type":"assistant","session_id":"`+claudeSID+`","message":{"role":"assistant","content":[`+
		`{"type":"tool_use","id":"tu-9","name":"SomeMcpTool","input":{"zzz":1}}]}}`)
	bs := toolBlocksOf(t, evs)
	if len(bs) != 1 || bs[0].Detail == "" {
		t.Fatalf("모르는 도구도 보일 것이 있어야 한다: %+v", bs)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(bs[0].Detail), &m); err != nil {
		t.Fatalf("모르는 도구의 detail 은 입력 JSON 이어야 한다: %q", bs[0].Detail)
	}
}

// V-M12-4: 편집은 **공통 어휘**로 온다. 종전에는 `_mkDiff()` 가 브라우저에서
// `old_string`/`new_string` 을 파싱했다 (누수 L3).
func TestClaudeProto_ToolViewEdit(t *testing.T) {
	p, st := protoOf(t)
	evs := decode1(t, p, st, `{"type":"assistant","session_id":"`+claudeSID+`","message":{"role":"assistant","content":[`+
		`{"type":"tool_use","id":"tu-2","name":"Edit","input":{"file_path":"/w/sample.txt",`+
		`"old_string":"world","new_string":"WORLD\nplus","replace_all":false}}]}}`)
	bs := toolBlocksOf(t, evs)
	if len(bs) != 1 || bs[0].Edit == nil {
		t.Fatalf("Edit 이 없다: %+v", bs)
	}
	e := bs[0].Edit
	if e.File != "/w/sample.txt" {
		t.Errorf("file=%q", e.File)
	}
	if len(e.Removed) != 1 || e.Removed[0] != "world" {
		t.Errorf("removed=%q", e.Removed)
	}
	if len(e.Added) != 2 || e.Added[0] != "WORLD" || e.Added[1] != "plus" {
		t.Errorf("added=%q", e.Added)
	}
}

// Write 는 새로 쓰는 것이므로 지워진 줄이 없다.
func TestClaudeProto_ToolViewWrite(t *testing.T) {
	p, st := protoOf(t)
	evs := decode1(t, p, st, `{"type":"assistant","session_id":"`+claudeSID+`","message":{"role":"assistant","content":[`+
		`{"type":"tool_use","id":"tu-3","name":"Write","input":{"file_path":"/w/new.txt","content":"one\ntwo"}}]}}`)
	bs := toolBlocksOf(t, evs)
	if len(bs) != 1 || bs[0].Edit == nil {
		t.Fatalf("Edit 이 없다: %+v", bs)
	}
	if len(bs[0].Edit.Removed) != 0 || len(bs[0].Edit.Added) != 2 {
		t.Fatalf("added/removed: %+v", bs[0].Edit)
	}
}

// 편집이 아닌 도구는 Edit 이 nil 이다 — 모든 도구에 편집을 달지 않는다.
func TestClaudeProto_ToolViewNoEditForBash(t *testing.T) {
	p, st := protoOf(t)
	evs := decode1(t, p, st, `{"type":"assistant","session_id":"`+claudeSID+`","message":{"role":"assistant","content":[`+
		`{"type":"tool_use","id":"tu-4","name":"Bash","input":{"command":"echo hi"}}]}}`)
	bs := toolBlocksOf(t, evs)
	if len(bs) != 1 || bs[0].Edit != nil {
		t.Fatalf("Bash 에 Edit 이 달렸다: %+v", bs)
	}
}

// V-M12-6: 백그라운드는 **입력이 스스로 말하는 사실**이다 (FR-M11-50).
func TestClaudeProto_ToolViewBackground(t *testing.T) {
	p, st := protoOf(t)
	evs := decode1(t, p, st, `{"type":"assistant","session_id":"`+claudeSID+`","message":{"role":"assistant","content":[`+
		`{"type":"tool_use","id":"tu-5","name":"Bash","input":{"command":"sleep 2","run_in_background":true}}]}}`)
	bs := toolBlocksOf(t, evs)
	if len(bs) != 1 || !bs[0].Background {
		t.Fatalf("background 가 서지 않았다: %+v", bs)
	}
}

// V-M12-4: codex 의 `fileChange` 는 **경로만** 준다. 줄을 지어내지 않는다 (D-M11-4).
func TestCodexProto_ToolViewEditPathsOnly(t *testing.T) {
	p, st := codexProtoOf(t)
	evs := decode1(t, p, st, `{"jsonrpc":"2.0","method":"item/started","params":{"threadId":"th-1","item":`+
		`{"id":"it-1","type":"fileChange","changes":[{"path":"/w/a.go"},{"path":"/w/b.go"}]}}}`)
	ev := toolStartOf(t, evs)
	if ev.Edit == nil {
		t.Fatalf("fileChange 에 Edit 이 없다: %+v", ev)
	}
	if ev.Edit.File != "/w/a.go, /w/b.go" {
		t.Errorf("file=%q — Detail 과 같은 문장이어야 한다", ev.Edit.File)
	}
	if len(ev.Edit.Added) != 0 || len(ev.Edit.Removed) != 0 {
		t.Errorf("codex 는 줄을 주지 않는다 — 비어 있어야 한다: %+v", ev.Edit)
	}
	// 배경은 codex 에 없는 개념이다.
	if ev.Background {
		t.Error("codex 에 백그라운드 개념이 없다 (FR-APS-4)")
	}
}

// codex 의 명령 실행은 종전대로 Detail 을 싣고 Edit 은 없다.
func TestCodexProto_ToolViewCommandDetail(t *testing.T) {
	p, st := codexProtoOf(t)
	evs := decode1(t, p, st, `{"jsonrpc":"2.0","method":"item/started","params":{"threadId":"th-1","item":`+
		`{"id":"it-2","type":"commandExecution","command":"go test ./..."}}}`)
	ev := toolStartOf(t, evs)
	if ev.Detail != "go test ./..." {
		t.Errorf("detail=%q", ev.Detail)
	}
	if ev.Edit != nil {
		t.Errorf("명령 실행에 Edit 이 달렸다: %+v", ev.Edit)
	}
}
