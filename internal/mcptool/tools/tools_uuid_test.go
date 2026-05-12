package tools

import (
	"context"
	"strings"
	"testing"

	"dongminal/internal/mcptool"
)

// FR-UID-7: list_panes 출력의 라인 끝에 uuid/short 가 부착된다. 기존 라인
// 앞부분 (label, paneId, shellPid, size, session, tab) 은 그대로 유지된다.
func TestListPanes_AppendsUUIDFields(t *testing.T) {
	pr := newFakePaneReader()
	pr.panes = []mcptool.PaneInfo{{ID: "pty-1", Name: "Shell", ShellPID: 100}}
	pr.has["pty-1"] = true
	wr := &fakeWorkspaceReader{
		entries: []mcptool.WorkspaceEntry{{
			PaneID:      "pty-1",
			Label:       "S1.P1.T1",
			SessionName: "Main",
			TabName:     "Shell",
			IsActive:    true,
			SessionUUID: "550e8400-e29b-41d4-a716-446655440001",
			RegionUUID:  "550e8400-e29b-41d4-a716-446655440002",
			TabUUID:     "550e8400-e29b-41d4-a716-446655440003",
			ShortCode:   "550e8400",
		}},
	}
	res, _ := dispatch(t, ListPanesName, ListPanesSpec, ListPanesHandler(ListPanesDeps{PM: pr, WS: wr}), "")
	body := resultText(res)

	if !strings.Contains(body, "uuid=550e8400-e29b-41d4-a716-446655440003") {
		t.Errorf("uuid not in body: %q", body)
	}
	if !strings.Contains(body, "short=550e8400") {
		t.Errorf("short not in body: %q", body)
	}
	if !strings.Contains(body, "▶ S1.P1.T1") || !strings.Contains(body, "paneId=pty-1") {
		t.Errorf("existing line content broken: %q", body)
	}
}

// NFR-UID-0: UUID 가 없는 엔트리의 출력은 변경 전과 완전히 동일해야 한다.
func TestListPanes_OmitsUUIDFieldsWhenAbsent(t *testing.T) {
	pr := newFakePaneReader()
	pr.panes = []mcptool.PaneInfo{{ID: "1", Name: "Shell", ShellPID: 100}}
	pr.has["1"] = true
	wr := &fakeWorkspaceReader{
		entries: []mcptool.WorkspaceEntry{{
			PaneID: "1", Label: "S1.P1.T1", IsActive: true,
		}},
	}
	res, _ := dispatch(t, ListPanesName, ListPanesSpec, ListPanesHandler(ListPanesDeps{PM: pr, WS: wr}), "")
	body := resultText(res)

	if strings.Contains(body, "uuid=") || strings.Contains(body, "short=") {
		t.Errorf("uuid/short leaked when TabUUID empty: %q", body)
	}
}

// FR-UID-6: who_am_i 도 uuid/short_code 를 라인 끝에 부착한다. session_uuid /
// region_uuid 는 TabUUID 가 있을 때만 함께 출력한다.
func TestWhoAmI_AppendsUUIDFields(t *testing.T) {
	pr := newFakePaneReader()
	pr.has["pty-1"] = true
	wr := &fakeWorkspaceReader{
		entries: []mcptool.WorkspaceEntry{{
			PaneID:      "pty-1",
			Label:       "S1.P1.T1",
			SessionName: "Main",
			TabName:     "Shell",
			SessionUUID: "550e8400-e29b-41d4-a716-446655440001",
			RegionUUID:  "550e8400-e29b-41d4-a716-446655440002",
			TabUUID:     "550e8400-e29b-41d4-a716-446655440003",
			ShortCode:   "550e8400",
		}},
	}
	h := WhoAmIHandler(WhoAmIDeps{PM: pr, WS: wr, Resolver: fakeResolver{pid: "pty-1", shell: 100}})
	ctx := mcptool.WithRemoteAddr(context.Background(), "127.0.0.1:1234")
	res, err := h(ctx, WhoAmIArgs{})
	if err != nil {
		t.Fatalf("WhoAmI: %v", err)
	}
	body := resultText(res)

	for _, want := range []string{
		"label=S1.P1.T1",
		"paneId=pty-1",
		"uuid=550e8400-e29b-41d4-a716-446655440003",
		"short=550e8400",
		"session_uuid=550e8400-e29b-41d4-a716-446655440001",
		"region_uuid=550e8400-e29b-41d4-a716-446655440002",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in: %q", want, body)
		}
	}
}

// NFR-UID-0: TabUUID 가 비어 있으면 기존 출력과 동일해야 한다.
func TestWhoAmI_OmitsUUIDFieldsWhenAbsent(t *testing.T) {
	pr := newFakePaneReader()
	pr.has["pty-1"] = true
	wr := &fakeWorkspaceReader{
		entries: []mcptool.WorkspaceEntry{{PaneID: "pty-1", Label: "S1.P1.T1"}},
	}
	h := WhoAmIHandler(WhoAmIDeps{PM: pr, WS: wr, Resolver: fakeResolver{pid: "pty-1", shell: 100}})
	ctx := mcptool.WithRemoteAddr(context.Background(), "127.0.0.1:1234")
	res, _ := h(ctx, WhoAmIArgs{})
	body := resultText(res)
	if strings.Contains(body, "uuid=") || strings.Contains(body, "short=") ||
		strings.Contains(body, "session_uuid=") || strings.Contains(body, "region_uuid=") {
		t.Errorf("uuid/short leaked when TabUUID empty: %q", body)
	}
}
