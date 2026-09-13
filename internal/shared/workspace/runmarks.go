package workspace

// ApplyRunMarks mutates the decoded workspace tree in place. It walks generic
// maps rather than typed structs so fields the server does not know about —
// everything the browser writes — survive the round trip. Reports whether
// anything changed. httpapi 의 Run 표식(FR-EM-17)이 부른다 — 트리의 모양을 아는
// 자리는 이 패키지다 (M8 D-A-13).
func ApplyRunMarks(tree map[string]any, tabs map[string]bool, windowID string, markWindow bool, runID string) bool {
	wins, _ := tree["windows"].([]any)
	changed := false
	for _, wv := range wins {
		win, _ := wv.(map[string]any)
		if win == nil {
			continue
		}
		if markWindow {
			if id, _ := win["id"].(string); id == windowID {
				changed = setOrClear(win, "ownerRunId", runID) || changed
			}
		} else if runID == "" && windowID != "" {
			if id, _ := win["id"].(string); id == windowID {
				changed = setOrClear(win, "ownerRunId", "") || changed
			}
		}
		if markTabsIn(win["layout"], tabs, runID) {
			changed = true
		}
	}
	return changed
}

// markTabsIn walks a layout node (pane or split) and marks matching tabs.
func markTabsIn(node any, tabs map[string]bool, runID string) bool {
	n, _ := node.(map[string]any)
	if n == nil {
		return false
	}
	changed := false
	if list, ok := n["tabs"].([]any); ok {
		for _, tv := range list {
			tab, _ := tv.(map[string]any)
			if tab == nil {
				continue
			}
			if id, _ := tab["id"].(string); tabs[id] {
				changed = setOrClear(tab, "runId", runID) || changed
			}
		}
	}
	if kids, ok := n["children"].([]any); ok {
		for _, kid := range kids {
			if markTabsIn(kid, tabs, runID) {
				changed = true
			}
		}
	}
	return changed
}

// setOrClear writes value or removes the key when value is empty. Reports
// whether the map changed — an unchanged tree must not cost a workspace save.
func setOrClear(m map[string]any, key, value string) bool {
	if value == "" {
		if _, ok := m[key]; !ok {
			return false
		}
		delete(m, key)
		return true
	}
	if cur, _ := m[key].(string); cur == value {
		return false
	}
	m[key] = value
	return true
}
