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

// FR-UID-12: workspace_command 의 location 에 uuid 를 넣으면 broadcast 직전에
// 좌표로 번역되어 브라우저는 변경 없이 정상 동작 (NFR-UID-0).
func TestWorkspaceCommand_TranslatesUUIDLocation(t *testing.T) {
	uuid := "550e8400-e29b-41d4-a716-446655440003"
	b := &fakeBroadcaster{allowed: map[string]bool{"focus": true}}
	wr := &fakeWorkspaceReader{coords: map[string]string{uuid: "S4.P1.T1"}}
	_, err := dispatch(t, WorkspaceCommandName, WorkspaceCommandSpec,
		WorkspaceCommandHandler(WorkspaceCommandDeps{Broadcaster: b, WS: wr}),
		`{"action":"focus","location":"`+uuid+`"}`)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if len(b.published) != 1 {
		t.Fatalf("published=%d", len(b.published))
	}
	if !strings.Contains(string(b.published[0]), `"location":"S4.P1.T1"`) {
		t.Errorf("broadcast missed coord rewrite: %s", b.published[0])
	}
	if strings.Contains(string(b.published[0]), uuid) {
		t.Errorf("uuid leaked into broadcast: %s", b.published[0])
	}
}

// FR-UID-8: send_agent_message 의 from 인자가 uuid 면 envelope 헤더의
// from= 는 사람 가독성을 위해 label 로 정규화된다. 라우팅 영향 없음
// (라우팅은 to 만 사용; from 은 메타데이터).
func TestSendAgentMessage_NormalizesUUIDFrom(t *testing.T) {
	toUUID := "550e8400-e29b-41d4-a716-446655440003"
	fromUUID := "550e8400-e29b-41d4-a716-446655440099"
	pr := newFakePaneReader()
	pr.has["10"] = true
	wr := &fakeWorkspaceReader{
		resolve: map[string]string{toUUID: "10", fromUUID: "99"},
		labels:  map[string]string{"10": "S2.P1.T1", "99": "S1.P1.T1"},
	}
	_, err := dispatch(t, SendAgentMessageName, SendAgentMessageSpec,
		SendAgentMessageHandler(SendAgentMessageDeps{PM: pr, WS: wr}),
		`{"to":"`+toUUID+`","from":"`+fromUUID+`","message":"hi"}`)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if len(pr.pastes) != 1 {
		t.Fatalf("pastes=%v", pr.pastes)
	}
	envelope := pr.pastes[0]
	if !strings.Contains(envelope, "from=S1.P1.T1") {
		t.Errorf("envelope from should be normalized to label, got: %q", envelope)
	}
	if !strings.Contains(envelope, "to=S2.P1.T1") {
		t.Errorf("envelope to should be normalized to label, got: %q", envelope)
	}
	if strings.Contains(envelope, fromUUID) || strings.Contains(envelope, toUUID) {
		t.Errorf("uuid should not leak into envelope (human-readable header): %q", envelope)
	}
}

// NFR-UID-0: from 이 label 형태로 들어오면 그대로 envelope 에 표시.
// 행위 보존 — 기존 라벨 기반 envelope 와 byte-wise 동일 동작.
func TestSendAgentMessage_LabelFromPassThrough(t *testing.T) {
	pr := newFakePaneReader()
	pr.has["10"] = true
	wr := &fakeWorkspaceReader{
		resolve: map[string]string{"S2.P1.T1": "10", "S1.P1.T1": "99"},
		labels:  map[string]string{"10": "S2.P1.T1", "99": "S1.P1.T1"},
	}
	_, err := dispatch(t, SendAgentMessageName, SendAgentMessageSpec,
		SendAgentMessageHandler(SendAgentMessageDeps{PM: pr, WS: wr}),
		`{"to":"S2.P1.T1","from":"S1.P1.T1","message":"hi"}`)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	envelope := pr.pastes[0]
	if !strings.Contains(envelope, "from=S1.P1.T1") {
		t.Errorf("label from should pass through verbatim, got: %q", envelope)
	}
}

// FR-UID-8 / TC-UID-5: send_agent_message 의 `to` 에 uuid 를 넣어도 라우팅
// 정상. 엔벨로프의 to= 는 사람 가독성을 위해 label 로 표시되며 (행위 보존),
// 송신 결과 paneId 는 uuid 가 가리키던 그 pane.
func TestSendAgentMessage_AcceptsUUIDInTo(t *testing.T) {
	tabUUID := "550e8400-e29b-41d4-a716-446655440003"
	pr := newFakePaneReader()
	pr.has["10"] = true
	wr := &fakeWorkspaceReader{
		resolve: map[string]string{tabUUID: "10"},
		labels:  map[string]string{"10": "S2.P1.T1"},
	}
	_, err := dispatch(t, SendAgentMessageName, SendAgentMessageSpec,
		SendAgentMessageHandler(SendAgentMessageDeps{PM: pr, WS: wr}),
		`{"to":"`+tabUUID+`","from":"S1.P1.T1","message":"hi"}`)
	if err != nil {
		t.Fatalf("Dispatch: %v", err)
	}
	if len(pr.pastes) != 1 {
		t.Fatalf("pastes=%v", pr.pastes)
	}
	envelope := pr.pastes[0]
	if !strings.Contains(envelope, "to=S2.P1.T1") {
		t.Errorf("envelope should display resolved label, got: %q", envelope)
	}
	if !strings.Contains(envelope, "hi") {
		t.Errorf("missing message: %q", envelope)
	}
}
