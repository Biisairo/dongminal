package workspace

import "testing"

// FR-UID-6/7: buildIndex 가 workspace.json 의 session/region/tab ID 를
// TabEntry 의 신규 UUID 필드로 그대로 surface 한다.
func TestBuildIndex_PopulatesUUIDFields(t *testing.T) {
	data := `{
		"activeWindow":"550e8400-e29b-41d4-a716-446655440001",
		"schemaVersion": 2, "windows":[{
			"id":"550e8400-e29b-41d4-a716-446655440001",
			"name":"Main",
			"focusedPane":"550e8400-e29b-41d4-a716-446655440002",
			"layout":{
				"type":"pane",
				"id":"550e8400-e29b-41d4-a716-446655440002",
				"activeTab":"550e8400-e29b-41d4-a716-446655440003",
				"tabs":[{
					"id":"550e8400-e29b-41d4-a716-446655440003",
					"name":"Shell",
					"toolId":"pty-1"
				}]
			}
		}]
	}`
	ix, err := buildIndex([]byte(data))
	if err != nil {
		t.Fatalf("buildIndex: %v", err)
	}
	if len(ix.entries) != 1 {
		t.Fatalf("entries=%d want 1", len(ix.entries))
	}
	e := ix.entries[0]
	if e.WindowUUID != "550e8400-e29b-41d4-a716-446655440001" {
		t.Errorf("WindowUUID=%q", e.WindowUUID)
	}
	if e.PaneUUID != "550e8400-e29b-41d4-a716-446655440002" {
		t.Errorf("PaneUUID=%q", e.PaneUUID)
	}
	if e.TabUUID != "550e8400-e29b-41d4-a716-446655440003" {
		t.Errorf("TabUUID=%q", e.TabUUID)
	}
	if e.ShortCode != "550e8400" {
		t.Errorf("ShortCode=%q want first 8 hex chars", e.ShortCode)
	}
	if e.ToolID != "pty-1" {
		t.Errorf("ToolID=%q (existing field must be preserved)", e.ToolID)
	}
	if e.Label != "W1.P1.T1" {
		t.Errorf("Label=%q (existing field must be preserved)", e.Label)
	}
}

// NFR-UID-0: workspace.json 에 UUID 필드가 없는 레거시 형식도 그대로 동작해야
// 한다 (행위 보존). 기존 필드만 채워지고 신규 UUID 필드는 비어 있다.
func TestBuildIndex_EmptyUUIDsAreTolerated(t *testing.T) {
	data := `{"activeWindow":"s1","schemaVersion": 2, "windows":[{"id":"s1","name":"x","focusedPane":"r1","layout":{"type":"pane","id":"r1","activeTab":"t1","tabs":[{"id":"t1","name":"a","toolId":"1"}]}}]}`
	ix, err := buildIndex([]byte(data))
	if err != nil {
		t.Fatalf("buildIndex: %v", err)
	}
	if len(ix.entries) != 1 {
		t.Fatalf("entries=%d want 1", len(ix.entries))
	}
	e := ix.entries[0]
	if e.ToolID != "1" || e.Label != "W1.P1.T1" {
		t.Errorf("existing fields broken: ToolID=%q Label=%q", e.ToolID, e.Label)
	}
	if e.WindowUUID != "s1" || e.PaneUUID != "r1" || e.TabUUID != "t1" {
		t.Errorf("short ids should pass through: %q %q %q",
			e.WindowUUID, e.PaneUUID, e.TabUUID)
	}
	if e.ShortCode != "t1" {
		t.Errorf("ShortCode=%q want %q (input shorter than 8 chars)", e.ShortCode, "t1")
	}
}

func TestShortCodeOf(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", ""},
		{"abc", "abc"},
		{"01234567", "01234567"},
		{"0123456789abcdef", "01234567"},
		{"550e8400-e29b-41d4-a716-446655440000", "550e8400"},
	}
	for _, c := range cases {
		if got := shortCodeOf(c.in); got != c.want {
			t.Errorf("shortCodeOf(%q)=%q want %q", c.in, got, c.want)
		}
	}
}
