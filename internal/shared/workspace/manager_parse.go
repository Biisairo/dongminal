package workspace

import (
	"encoding/json"
	"fmt"
	"strings"
)

// M9_SRS FR-M9-15 (D-A-10 — 분리는 **이동만**이다): `manager.go` 에서 옮겨 왔다.
//
// 여기 모인 것은 **workspace.json 을 읽는 일**이다 — 트리의 모양과 그것에서 만드는
// 색인. `manager.go` 에 남은 것은 그 색인을 **들고 있는 일**(저장·개정·쓰기 큐)이며,
// 파일 형식이 바뀌어도 그 수명은 바뀌지 않는다.

// ── workspace.json parsing ──────────────────────────

type WsLayout struct {
	Type      string      `json:"type"`
	ID        string      `json:"id,omitempty"`
	Tabs      []WsTab     `json:"tabs,omitempty"`
	ActiveTab string      `json:"activeTab,omitempty"`
	Direction string      `json:"direction,omitempty"`
	Children  []*WsLayout `json:"children,omitempty"`
}

type WsTab struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	ToolID string `json:"toolId"`
	// RunID는 이 탭의 도구를 소유한 Run (FR-EM-17 접합면). 비어 있으면
	// 어느 Run 에도 속하지 않는다 — 사람이 직접 만든 도구의 정상 상태다.
	RunID string `json:"runId,omitempty"`
}

type wsWindow struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Layout      *WsLayout `json:"layout"`
	FocusedPane string    `json:"focusedPane"`
	// OwnerRunID는 이 Window 를 전용으로 만든 Run (Projection
	// dedicated-window). 비어 있으면 사용자 소유 Window 다 (FR-EM-17).
	OwnerRunID string `json:"ownerRunId,omitempty"`
	// Sandbox는 이 Window 의 샌드박스 프로파일 이름이다. 비어 있으면 일반
	// Window 이며, 그 의미가 이 필드가 없던 파일의 의미와 같다 — 그래서
	// schemaVersion 을 올리지 않는다 (SANDBOX_WINDOW_SRS FR-SBX-18/19).
	Sandbox string `json:"sandbox,omitempty"`
}

// WindowInfo 는 Window 하나의 배치 정보다. 대응 컨테이너를 만들 자리(Sandbox)와
// 회수 대상 판정의 키(UUID)를 함께 낸다.
type WindowInfo struct {
	UUID    string
	Sandbox string
}

type wsState struct {
	SchemaVersion int        `json:"schemaVersion"`
	Windows       []wsWindow `json:"windows"`
	ActiveWindow  string     `json:"activeWindow"`
}

func emptyIndex() *index {
	return &index{
		labels:    map[string]string{},
		labelToID: map[string]string{},
		tabIDs:    map[string]struct{}{},
		uuidToID:  map[string]string{},
	}
}

// decodeState 는 저장된 blob 을 상태로 되돌린다. 파싱과 **스키마 버전 판정**의
// 유일한 자리다 (FR-EM-2a).
//
// 한 자리인 것이 요점이다. 판정이 두 곳에 흩어져 있으면 한쪽만 갱신해도 컴파일이
// 통과하고, 그때 구 blob 이 갱신되지 않은 쪽에서 "아무것도 참조하지 않음" 으로
// 읽혀 세션 전체가 폐기된다.
//
// 빈 blob 은 (nil, nil) 이다 — 오류가 아니라 "상태가 아직 없다" 이며, 호출자의
// 빈 결과 경로로 간다.
func decodeState(blob []byte) (*wsState, error) {
	if len(blob) == 0 {
		return nil, nil
	}
	var s wsState
	if err := json.Unmarshal(blob, &s); err != nil {
		return nil, err
	}
	if s.SchemaVersion > SchemaVersion {
		return nil, ErrSchemaTooNew
	}
	if s.SchemaVersion < SchemaVersion {
		return nil, ErrSchemaTooOld
	}
	return &s, nil
}

// Windows 는 지금 저장된 Window 들이다 (FR-SBX-9 회수의 "살아 있는 Window").
func (m *Manager) Windows() []WindowInfo { return windowsOf(m.Raw()) }

// windowsOf 는 blob 에서 Window 목록을 뽑는다.
//
// **탭의 유무를 보지 않는다.** 탭을 다 닫아 둔 샌드박스 창도 살아 있는 Window
// 이며, 여기서 빠지면 그 창의 대응 컨테이너가 고아로 오인되어 회수된다.
//
// 해석할 수 없는 blob 은 빈 목록이다. 호출자(회수)는 빈 목록을 "지울 것이
// 없다" 가 아니라 "판단 근거가 없다" 로 다뤄야 한다 — 그렇지 않으면 파일 하나가
// 깨졌을 때 모든 컨테이너를 지운다.
func windowsOf(blob []byte) []WindowInfo {
	st, err := decodeState(blob)
	if err != nil || st == nil {
		return nil
	}
	out := make([]WindowInfo, 0, len(st.Windows))
	for _, w := range st.Windows {
		if w.ID == "" {
			continue
		}
		out = append(out, WindowInfo{UUID: w.ID, Sandbox: w.Sandbox})
	}
	return out
}

func buildIndex(blob []byte) (*index, error) {
	ix := emptyIndex()
	s, err := decodeState(blob)
	if err != nil {
		return nil, err
	}
	if s == nil {
		return ix, nil
	}
	for si, sess := range s.Windows {
		var regions []*WsLayout
		CollectPanes(sess.Layout, &regions)
		for pi, rg := range regions {
			for ti, tab := range rg.Tabs {
				isActive := sess.ID == s.ActiveWindow && sess.FocusedPane == rg.ID && rg.ActiveTab == tab.ID
				label := fmt.Sprintf("W%d.P%d.T%d", si+1, pi+1, ti+1)
				ix.entries = append(ix.entries, TabEntry{
					ToolID:     tab.ToolID,
					Label:      label,
					WindowName: sess.Name,
					TabName:    tab.Name,
					IsActive:   isActive,
					WindowUUID: sess.ID,
					PaneUUID:   rg.ID,
					TabUUID:    tab.ID,
					ShortCode:  shortCodeOf(tab.ID),
				})
				ix.labels[tab.ToolID] = label
				ix.labelToID[label] = tab.ToolID
				if tab.ID != "" {
					ix.tabIDs[tab.ID] = struct{}{}
					ix.uuidToID[strings.ToLower(tab.ID)] = tab.ToolID
				}
			}
		}
	}
	return ix, nil
}

// shortCodeOf returns the leading 8 hex chars of a canonical UUID, used as a
// log-readability alias (NFR-UID-4). Falls back to the raw string when the
// input is shorter than 8 chars or empty.
func shortCodeOf(uuid string) string {
	if len(uuid) >= 8 {
		return uuid[:8]
	}
	return uuid
}

// CollectPanes walks a layout tree and appends every "tool" node to out.
func CollectPanes(n *WsLayout, out *[]*WsLayout) {
	if n == nil {
		return
	}
	if n.Type == "pane" {
		*out = append(*out, n)
		return
	}
	if n.Type == "split" {
		for _, c := range n.Children {
			CollectPanes(c, out)
		}
	}
}

// ReferencedToolIDs returns the set of tool ids that some tab in blob points
// at. Used at boot to distinguish live tools from orphans in tools.json
// (FR-EM-14) — a tool nobody references is unreachable from any UI and must
// not be respawned.
//
// Tabs without a tool (editor/markdown) contribute nothing. An empty blob
// yields an empty set. A pre-v2 blob is an error, never an empty set: silently
// treating it as "nothing referenced" would classify every tool as an orphan
// and discard the user's whole session.
func ReferencedToolIDs(blob []byte) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	s, err := decodeState(blob)
	if err != nil {
		return nil, err
	}
	if s == nil {
		return out, nil
	}
	for _, win := range s.Windows {
		var tools []*WsLayout
		CollectPanes(win.Layout, &tools)
		for _, pn := range tools {
			for _, tab := range pn.Tabs {
				if tab.ToolID != "" {
					out[tab.ToolID] = struct{}{}
				}
			}
		}
	}
	return out, nil
}
