package mcptool_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"dongminal/internal/mcptool"
	"dongminal/internal/mcptool/tools"
)

// ── fake tool for Registry-level tests ───────────────

type fakeTool struct {
	name string
	spec map[string]any
	call func(ctx context.Context, args json.RawMessage) (mcptool.Result, error)
}

func (f fakeTool) Name() string          { return f.name }
func (f fakeTool) Spec() map[string]any  { return f.spec }
func (f fakeTool) Call(ctx context.Context, args json.RawMessage) (mcptool.Result, error) {
	return f.call(ctx, args)
}

func TestUnknownTool(t *testing.T) {
	r := mcptool.NewRegistry()
	_, err := r.Dispatch(context.Background(), "nope", nil)
	if !errors.Is(err, mcptool.ErrUnknownTool) {
		t.Fatalf("want ErrUnknownTool, got %v", err)
	}
}

func TestDispatchText(t *testing.T) {
	r := mcptool.NewRegistry()
	r.Register(fakeTool{
		name: "echo",
		call: func(_ context.Context, _ json.RawMessage) (mcptool.Result, error) {
			return mcptool.TextResult("hi"), nil
		},
	})
	res, err := r.Dispatch(context.Background(), "echo", nil)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	content, ok := res["content"].([]map[string]any)
	if !ok || len(content) != 1 || content[0]["text"] != "hi" {
		t.Fatalf("unexpected result: %#v", res)
	}
}

func TestInvalidArgs(t *testing.T) {
	// A tool that unmarshals args into a specific struct. Malformed JSON must
	// surface as an error from Dispatch (Stage 1: tools return the error;
	// Stage 2 ergonomics will convert to ErrorResult).
	r := mcptool.NewRegistry()
	r.Register(fakeTool{
		name: "pick",
		call: func(_ context.Context, raw json.RawMessage) (mcptool.Result, error) {
			var v struct {
				N int `json:"n"`
			}
			if err := json.Unmarshal(raw, &v); err != nil {
				return nil, err
			}
			return mcptool.TextResult("ok"), nil
		},
	})
	_, err := r.Dispatch(context.Background(), "pick", json.RawMessage(`{"n":"not-an-int"}`))
	if err == nil {
		t.Fatalf("expected unmarshal error, got nil")
	}
}

// ── generic Register[A] / Textf ──────────────────────

func TestRegisterGeneric(t *testing.T) {
	r := mcptool.NewRegistry()
	type args struct {
		N    int    `json:"n"`
		Note string `json:"note"`
	}
	spec := map[string]any{"name": "pickN", "inputSchema": map[string]any{"type": "object"}}
	mcptool.Register(r, "pickN", spec, func(_ context.Context, a args) (mcptool.Result, error) {
		return mcptool.Textf("n=%d note=%s", a.N, a.Note), nil
	})
	res, err := r.Dispatch(context.Background(), "pickN", json.RawMessage(`{"n":42,"note":"hi"}`))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	content := res["content"].([]map[string]any)
	if content[0]["text"] != "n=42 note=hi" {
		t.Fatalf("unexpected text: %q", content[0]["text"])
	}
	// Spec passthrough for tools/list.
	list := r.List()
	if len(list) != 1 || list[0]["name"] != "pickN" {
		t.Fatalf("unexpected List(): %#v", list)
	}
}

func TestGenericInvalidJSON(t *testing.T) {
	r := mcptool.NewRegistry()
	type args struct {
		N int `json:"n"`
	}
	mcptool.Register(r, "pickN", nil, func(_ context.Context, a args) (mcptool.Result, error) {
		return mcptool.TextResult("ok"), nil
	})
	res, err := r.Dispatch(context.Background(), "pickN", json.RawMessage(`{"n":"not-an-int"}`))
	if err != nil {
		t.Fatalf("expected nil error (ErrorResult path), got %v", err)
	}
	if res["isError"] != true {
		t.Fatalf("expected isError=true, got %#v", res)
	}
	content := res["content"].([]map[string]any)
	text, _ := content[0]["text"].(string)
	if !strings.HasPrefix(text, "잘못된 인자: ") {
		t.Fatalf("expected 잘못된 인자 prefix, got %q", text)
	}
}

func TestTextf(t *testing.T) {
	res := mcptool.Textf("x=%d y=%s", 7, "q")
	content, ok := res["content"].([]map[string]any)
	if !ok || len(content) != 1 {
		t.Fatalf("unexpected envelope: %#v", res)
	}
	if content[0]["type"] != "text" {
		t.Fatalf("expected type=text, got %v", content[0]["type"])
	}
	if content[0]["text"] != "x=7 y=q" {
		t.Fatalf("unexpected text: %v", content[0]["text"])
	}
	if _, isErr := res["isError"]; isErr {
		t.Fatalf("Textf must not set isError")
	}
}

// ── PaneReader / WorkspaceReader fakes ───────────────

type fakePM struct {
	panes    []mcptool.PaneInfo
	sizeMap  map[string]string
	snap     map[string][]byte
	dropped  map[string]int64
	pastes   []string // paneID|submit|text
}

func (f *fakePM) List() []mcptool.PaneInfo { return f.panes }

func (f *fakePM) Has(id string) bool {
	for _, p := range f.panes {
		if p.ID == id {
			return true
		}
	}
	return false
}

func (f *fakePM) Snapshot(id string) ([]byte, int64, bool) {
	d, ok := f.snap[id]
	if !ok {
		return nil, 0, false
	}
	return d, f.dropped[id], true
}

func (f *fakePM) Size(id string) string {
	if s, ok := f.sizeMap[id]; ok {
		return s
	}
	return "?"
}

func (f *fakePM) SendPaste(id string, text []byte, submit bool) error {
	f.pastes = append(f.pastes, id+"|"+boolStr(submit)+"|"+string(text))
	return nil
}

func boolStr(b bool) string {
	if b {
		return "t"
	}
	return "f"
}

type fakeWS struct {
	entries []mcptool.WorkspaceEntry
	resolve map[string]string
	labels  map[string]string
}

func (f *fakeWS) Resolve(id string) (string, error) {
	if pid, ok := f.resolve[id]; ok {
		return pid, nil
	}
	return "", errors.New("unknown id: " + id)
}
func (f *fakeWS) Labels() map[string]string            { return f.labels }
func (f *fakeWS) Entries() []mcptool.WorkspaceEntry    { return f.entries }

// ── per-tool tests ───────────────────────────────────

func TestListPanesTool(t *testing.T) {
	pm := &fakePM{
		panes: []mcptool.PaneInfo{
			{ID: "p1", Name: "a", ShellPID: 111},
			{ID: "p2", Name: "b", ShellPID: 222},
		},
		sizeMap: map[string]string{"p1": "80x24", "p2": "?"},
	}
	ws := &fakeWS{entries: []mcptool.WorkspaceEntry{
		{PaneID: "p1", Label: "S1.P1.T1", SessionName: "main", TabName: "zsh", IsActive: true},
	}}
	res, err := tools.ListPanes{PM: pm, WS: ws}.Call(context.Background(), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	content := res["content"].([]map[string]any)
	text := content[0]["text"].(string)
	if !strings.Contains(text, "▶ S1.P1.T1") {
		t.Errorf("expected active marker, got %q", text)
	}
	if !strings.Contains(text, "workspace 미등록") || !strings.Contains(text, "paneId=p2") {
		t.Errorf("expected orphan p2, got %q", text)
	}
}

func TestListPanesFiltersDeadEntries(t *testing.T) {
	pm := &fakePM{
		panes: []mcptool.PaneInfo{
			{ID: "p1", Name: "a", ShellPID: 111},
			{ID: "p2", Name: "b", ShellPID: 222},
		},
		sizeMap: map[string]string{"p1": "80x24", "p2": "80x24"},
	}
	ws := &fakeWS{entries: []mcptool.WorkspaceEntry{
		{PaneID: "p1", Label: "S1.P1.T1", SessionName: "main", TabName: "zsh"},
		{PaneID: "p2", Label: "S1.P1.T2", SessionName: "main", TabName: "zsh"},
		{PaneID: "p3", Label: "S1.P1.T3", SessionName: "main", TabName: "zsh"},
	}}
	res, err := tools.ListPanes{PM: pm, WS: ws}.Call(context.Background(), nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	content := res["content"].([]map[string]any)
	text := content[0]["text"].(string)
	if !strings.Contains(text, "paneId=p1") || !strings.Contains(text, "paneId=p2") {
		t.Errorf("expected live panes p1/p2 in output, got %q", text)
	}
	if strings.Contains(text, "S1.P1.T3") || strings.Contains(text, "paneId=p3") {
		t.Errorf("dead entry p3 should be filtered out, got %q", text)
	}
}

func TestSendInputTool(t *testing.T) {
	pm := &fakePM{panes: []mcptool.PaneInfo{{ID: "p1"}}}
	ws := &fakeWS{resolve: map[string]string{"S1.P1.T1": "p1"}}
	_, err := tools.SendInput{PM: pm, WS: ws}.Call(context.Background(),
		json.RawMessage(`{"id":"S1.P1.T1","text":"hello","execute":true}`))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(pm.pastes) != 1 || !strings.HasPrefix(pm.pastes[0], "p1|t|hello") {
		t.Fatalf("unexpected pastes: %v", pm.pastes)
	}
}

func TestSendInputUnknownID(t *testing.T) {
	pm := &fakePM{}
	ws := &fakeWS{}
	_, err := tools.SendInput{PM: pm, WS: ws}.Call(context.Background(),
		json.RawMessage(`{"id":"S9.P9.T9","text":"x"}`))
	if err == nil {
		t.Fatal("expected resolve error")
	}
}
