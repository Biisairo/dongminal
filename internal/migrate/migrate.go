// Package migrate는 엔티티 모델 재정비(ENTITY_MODEL_RESTRUCTURE_SRS)의 1회성
// 데이터 변환을 수행한다. workspace.json 을 v2 스키마로 옮기고 panes.json 을
// tools.json 내용으로 바꾸며, 그 과정에서 고아 도구와 유령 참조를 제거한다.
//
// 변환은 순수 함수다 — 파일 IO·백업은 호출자(cmd)가 담당한다. 미지 필드를
// 보존하기 위해 타입 구조체가 아닌 generic map 을 순회한다.
package migrate

import (
	"encoding/json"
	"fmt"
	"strings"
)

// SchemaVersion은 본 SRS 가 도입하는 workspace.json 스키마 버전이다 (FR-EM-2a).
const SchemaVersion = 2

type Report struct {
	// Empty는 변환할 입력이 없었음을 뜻한다 (신규 사용자).
	Empty bool
	// AlreadyMigrated는 입력이 이미 v2 스키마였음을 뜻한다.
	AlreadyMigrated bool

	Windows int
	Tools   int

	// Orphans는 어떤 탭도 참조하지 않아 tools.json 에서 제외된 도구 id.
	Orphans []string
	// GhostRefs는 존재하지 않는 도구를 가리켜 agentsOrder 에서 제거된 id.
	GhostRefs []string
	// ShortcutsRenamed는 settings.json 에서 개명된 단축키 action id 목록.
	ShortcutsRenamed []string

	// BrokenRefs는 탭이 참조하지만 도구 컬렉션에 없는 id. 제거하지 않고 보고만
	// 한다 — 탭 정리는 런타임 무결성 검사(FR-EM-14)의 책임이다.
	BrokenRefs []string
}

type Result struct {
	Workspace []byte
	Tools     []byte
	Report    Report
}

// Run은 v1 workspace.json 과 panes.json 블롭을 받아 v2 산출물을 반환한다.
// 멱등하다 — 이미 v2 인 입력은 구조를 바꾸지 않고 정리만 재수행한다.
func Run(workspaceBlob, panesBlob []byte) (Result, error) {
	var res Result

	wsEmpty := len(strings.TrimSpace(string(workspaceBlob))) == 0
	pnEmpty := len(strings.TrimSpace(string(panesBlob))) == 0
	if wsEmpty && pnEmpty {
		res.Report.Empty = true
		return res, nil
	}

	ws := map[string]interface{}{}
	if !wsEmpty {
		if err := json.Unmarshal(workspaceBlob, &ws); err != nil {
			return Result{}, fmt.Errorf("workspace 파싱: %w", err)
		}
	}
	var panes []interface{}
	if !pnEmpty {
		if err := json.Unmarshal(panesBlob, &panes); err != nil {
			return Result{}, fmt.Errorf("panes 파싱: %w", err)
		}
	}

	res.Report.AlreadyMigrated = schemaVersionOf(ws) >= SchemaVersion

	if !res.Report.AlreadyMigrated {
		renameKey(ws, "sessions", "windows")
		renameKey(ws, "activeSession", "activeWindow")
	}
	windows, _ := ws["windows"].([]interface{})
	res.Report.Windows = len(windows)

	for _, raw := range windows {
		win, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if !res.Report.AlreadyMigrated {
			renameKey(win, "focusedRegion", "focusedPane")
		}
		if layout, ok := win["layout"].(map[string]interface{}); ok {
			convertLayout(layout, res.Report.AlreadyMigrated)
		}
	}

	refs := collectToolRefs(windows)
	refSet := make(map[string]struct{}, len(refs))
	for _, id := range refs {
		refSet[id] = struct{}{}
	}

	tools := make([]interface{}, 0, len(panes))
	have := make(map[string]struct{}, len(panes))
	for _, raw := range panes {
		item, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		id, _ := item["id"].(string)
		if _, referenced := refSet[id]; !referenced {
			res.Report.Orphans = append(res.Report.Orphans, id)
			continue
		}
		have[id] = struct{}{}
		tools = append(tools, item)
	}
	res.Report.Tools = len(tools)

	for _, id := range refs {
		if _, ok := have[id]; !ok {
			res.Report.BrokenRefs = append(res.Report.BrokenRefs, id)
		}
	}

	if order, ok := ws["agentsOrder"].([]interface{}); ok {
		kept := make([]interface{}, 0, len(order))
		for _, raw := range order {
			id, _ := raw.(string)
			if _, ok := have[id]; ok {
				kept = append(kept, raw)
				continue
			}
			res.Report.GhostRefs = append(res.Report.GhostRefs, id)
		}
		ws["agentsOrder"] = kept
	}

	ws["schemaVersion"] = SchemaVersion

	if !wsEmpty {
		out, err := json.Marshal(ws)
		if err != nil {
			return Result{}, fmt.Errorf("workspace 직렬화: %w", err)
		}
		res.Workspace = out
	}
	if !pnEmpty {
		out, err := json.Marshal(tools)
		if err != nil {
			return Result{}, fmt.Errorf("tools 직렬화: %w", err)
		}
		res.Tools = out
	}
	return res, nil
}

func schemaVersionOf(ws map[string]interface{}) int {
	v, ok := ws["schemaVersion"].(float64)
	if !ok {
		return 0
	}
	return int(v)
}

func renameKey(m map[string]interface{}, from, to string) {
	if v, ok := m[from]; ok {
		m[to] = v
		delete(m, from)
	}
}

// convertLayout은 레이아웃 트리를 재귀 순회해 region→pane, paneId→toolId 를
// 적용한다. 알려지지 않은 type 은 변형하지 않고 자식만 순회한다.
func convertLayout(node map[string]interface{}, alreadyMigrated bool) {
	if !alreadyMigrated {
		if node["type"] == "region" {
			node["type"] = "pane"
		}
		if tabs, ok := node["tabs"].([]interface{}); ok {
			for _, raw := range tabs {
				if tab, ok := raw.(map[string]interface{}); ok {
					renameKey(tab, "paneId", "toolId")
				}
			}
		}
	}
	if children, ok := node["children"].([]interface{}); ok {
		for _, raw := range children {
			if child, ok := raw.(map[string]interface{}); ok {
				convertLayout(child, alreadyMigrated)
			}
		}
	}
}

// collectToolRefs는 문서 순서대로 탭이 참조하는 도구 id 를 중복 없이 모은다.
// v1(paneId)·v2(toolId) 양쪽 키를 모두 인식해 멱등성을 보장한다.
func collectToolRefs(windows []interface{}) []string {
	var out []string
	seen := map[string]struct{}{}
	var walk func(node map[string]interface{})
	walk = func(node map[string]interface{}) {
		if tabs, ok := node["tabs"].([]interface{}); ok {
			for _, raw := range tabs {
				tab, ok := raw.(map[string]interface{})
				if !ok {
					continue
				}
				id, _ := tab["toolId"].(string)
				if id == "" {
					id, _ = tab["paneId"].(string)
				}
				if id == "" {
					continue
				}
				if _, dup := seen[id]; dup {
					continue
				}
				seen[id] = struct{}{}
				out = append(out, id)
			}
		}
		if children, ok := node["children"].([]interface{}); ok {
			for _, raw := range children {
				if child, ok := raw.(map[string]interface{}); ok {
					walk(child)
				}
			}
		}
	}
	for _, raw := range windows {
		win, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if layout, ok := win["layout"].(map[string]interface{}); ok {
			walk(layout)
		}
	}
	return out
}
