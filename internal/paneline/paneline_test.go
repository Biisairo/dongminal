package paneline

import "testing"

// TC-PL-1: 모든 필드 채워진 정상 케이스.
func TestRender_Full(t *testing.T) {
	l := Line{
		FocusMarker: true,
		Label:       "S1.P1.T1",
		UUID:        "550e8400-e29b-41d4-a716-446655440003",
		Short:       "550e8400",
		PaneID:      "12",
		ShellPID:    12345,
		SizeCols:    80,
		SizeRows:    24,
		Session:     "Main",
		Tab:         "Shell",
		SessionUUID: "550e8400-e29b-41d4-a716-446655440001",
		RegionUUID:  "550e8400-e29b-41d4-a716-446655440002",
	}
	got := l.Render()
	want := "▶ label=S1.P1.T1  uuid=550e8400-e29b-41d4-a716-446655440003  short=550e8400  paneId=12  shellPid=12345  size=80x24  session=\"Main\"  tab=\"Shell\"  session_uuid=550e8400-e29b-41d4-a716-446655440001  region_uuid=550e8400-e29b-41d4-a716-446655440002"
	if got != want {
		t.Fatalf("Render mismatch:\n got=%q\nwant=%q", got, want)
	}
}

// TC-PL-2: uuid/short 빈 → 두 컬럼 모두 생략.
func TestRender_OmitUUIDShort(t *testing.T) {
	l := Line{Label: "S1.P1.T1", PaneID: "12", ShellPID: 1, SizeCols: 80, SizeRows: 24, Session: "x", Tab: "y"}
	got := l.Render()
	want := "  label=S1.P1.T1  paneId=12  shellPid=1  size=80x24  session=\"x\"  tab=\"y\""
	if got != want {
		t.Fatalf("got=%q\nwant=%q", got, want)
	}
}

// TC-PL-3: session_uuid/region_uuid 빈 → 두 컬럼 모두 생략.
func TestRender_OmitSessionRegionUUID(t *testing.T) {
	l := Line{Label: "S1.P1.T1", UUID: "u", Short: "s", PaneID: "1", ShellPID: 2, SizeCols: 1, SizeRows: 2, Session: "a", Tab: "b"}
	got := l.Render()
	want := "  label=S1.P1.T1  uuid=u  short=s  paneId=1  shellPid=2  size=1x2  session=\"a\"  tab=\"b\""
	if got != want {
		t.Fatalf("got=%q\nwant=%q", got, want)
	}
}

// TC-PL-4: size 0x0 → size 컬럼 생략.
func TestRender_OmitZeroSize(t *testing.T) {
	l := Line{Label: "L", PaneID: "1", ShellPID: 1, Session: "a", Tab: "b"}
	got := l.Render()
	want := `  label=L  paneId=1  shellPid=1  session="a"  tab="b"`
	if got != want {
		t.Fatalf("got=%q\nwant=%q", got, want)
	}
}

// TC-PL-5: FocusMarker=false → 두 칸 공백.
func TestRender_UnfocusedMarker(t *testing.T) {
	l := Line{FocusMarker: false, Label: "L", PaneID: "1", ShellPID: 1, Session: "a", Tab: "b"}
	if got := l.Render(); got[:2] != "  " {
		t.Fatalf("expected two-space prefix, got=%q", got[:2])
	}
}

// TC-PL-6: session/tab 안에 큰따옴표 포함 → Go %q 이스케이프.
func TestRender_QuoteEscape(t *testing.T) {
	l := Line{Label: "L", PaneID: "1", ShellPID: 1, Session: `a"b`, Tab: "c"}
	got := l.Render()
	if !contains(got, `session="a\"b"`) {
		t.Fatalf("expected escaped session quote, got=%q", got)
	}
}

// 결정성: 같은 입력 두 번 호출 시 동일 (NFR-WAI-4).
func TestRender_Deterministic(t *testing.T) {
	l := Line{Label: "L", UUID: "u", Short: "s", PaneID: "1", ShellPID: 2, SizeCols: 80, SizeRows: 24, Session: "x", Tab: "y", SessionUUID: "su", RegionUUID: "ru"}
	if l.Render() != l.Render() {
		t.Fatal("non-deterministic")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
