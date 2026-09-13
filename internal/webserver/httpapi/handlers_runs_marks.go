package httpapi

import (
	"encoding/json"
	"errors"
	"strconv"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/workspace"
	"dongminal/internal/webserver/domain/run"
)

// tabIDOfTool finds the tab uuid that hosts a tool. Empty when the tool is not
// referenced by any tab (a background tool, for instance).
func (s *Server) tabIDOfTool(toolID string) string {
	if s.WorkIndex == nil {
		return ""
	}
	for _, e := range s.WorkIndex.Entries() {
		if e.ToolID == toolID {
			return e.TabUUID
		}
	}
	return ""
}

// markWorkspaceRun writes (or clears) the FR-EM-17 junction fields:
// `tab.runId` for tabID, and `window.ownerRunId` for a dedicated-window Run.
// runID == "" clears both for every member tab of rec.
//
// **Best-effort by design.** workspace.json 의 쓰기 주체는 브라우저이고, 그쪽의
// 409 처리는 머지 없이 재PUT 이다 (WORKSPACE_IDENTITY_SRS §2.4) — 동시 편집이
// 겹치면 이 표식이 지워질 수 있다. 표식은 UI·관측용 보조이며 소유권의 진실은
// runs.json 이다 (FR-RUN-10). 그래서 실패는 로그 한 줄로 끝내고 요청을 깨뜨리지
// 않는다 (NFR-RUN-3).
func (s *Server) markWorkspaceRun(rec run.Record, tabID, runID string) {
	s.markWorkspaceRunExcept(rec, tabID, runID, nil)
}

// markWorkspaceRunExcept 는 skip 에 든 탭을 대상에서 뺀다 (FR-RUN-6d). 정리가
// 이미 닫은 자리가 그것이며, 그 자리의 표식은 지울 것이 없다 — 탭이 사라진다.
//
// 멤버 탭이 하나도 남지 않으면 **창의 표식도 대상이 아니다.** 마지막 탭이 닫히면
// 전용 창은 스스로 사라지고, 그때 쓰는 한 줄이 브라우저의 삭제를 409 로 되돌린다.
func (s *Server) markWorkspaceRunExcept(rec run.Record, tabID, runID string, skip map[string]bool) {
	if s.Work == nil {
		return
	}
	tabs := map[string]bool{}
	if tabID != "" {
		if !skip[tabID] {
			tabs[tabID] = true
		}
	} else {
		for _, m := range rec.Members {
			if m.TabID != "" && !skip[m.TabID] {
				tabs[m.TabID] = true
			}
		}
	}
	windowID := rec.WindowID
	if len(skip) > 0 && len(tabs) == 0 {
		windowID = "" // 창이 사라진다 — 그 표식을 쓰려고 rev 를 올리지 않는다
	}
	markWindow := rec.Projection == run.DedicatedWindow && windowID != ""

	for attempt := 0; attempt < 3; attempt++ {
		blob, rev := s.Work.Snapshot()
		if len(blob) == 0 {
			return
		}
		var tree map[string]any
		if err := json.Unmarshal(blob, &tree); err != nil {
			dmlog.Errorf(nil, "[run] workspace 표식 생략 — 파싱 실패: %v", err)
			return
		}
		if !workspace.ApplyRunMarks(tree, tabs, windowID, markWindow, runID) {
			return // 바꿀 것이 없다
		}
		out, err := json.Marshal(tree)
		if err != nil {
			dmlog.Errorf(nil, "[run] workspace 표식 생략 — 직렬화 실패: %v", err)
			return
		}
		newRev, err := s.Work.Save(out, strconv.FormatUint(rev, 10))
		if err == nil {
			if s.Commands != nil {
				payload, _ := json.Marshal(map[string]any{
					"action": "workspace_changed",
					"args":   map[string]any{"rev": newRev},
				})
				s.Commands.Broadcast(payload)
			}
			return
		}
		if !errors.Is(err, workspace.ErrStale) {
			dmlog.Errorf(nil, "[run] workspace 표식 실패: %v", err)
			return
		}
	}
	dmlog.Infof(nil, "[run] workspace 표식 포기 — 동시 편집으로 3회 stale (runId=%s)", runID)
}

// closedTabIDs 는 정리가 **실제로 닫은** 탭의 uuid 집합이다 (FR-RUN-6d). 방송이
// 아무 데도 가지 않은 탭은 남아 있으므로 표식 해제 대상이다 (M8 D-A-3).
func closedTabIDs(closed []map[string]any) map[string]bool {
	out := map[string]bool{}
	for _, c := range closed {
		if ok, _ := c["closed"].(bool); !ok {
			continue
		}
		if id, _ := c["tabId"].(string); id != "" {
			out[id] = true
		}
	}
	return out
}
