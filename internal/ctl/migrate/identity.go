package migrate

import (
	"encoding/json"
	"fmt"

	"dongminal/internal/shared/uuid"
)

// IdentityReport는 구 식별자 재작성의 결과다 (FR-MGU-10).
type IdentityReport struct {
	Windows int
	Panes   int
	Tabs    int
	Tools   int

	// Dangling은 재작성 매핑에 없어 값을 보존한 구 형식 참조다 (FR-MGU-6).
	// 정리는 런타임 무결성 검사(FR-EM-14)의 책임이지 마이그레이션의 책임이
	// 아니므로, 여기서는 보고만 한다.
	Dangling []string
}

func (r IdentityReport) Total() int { return r.Windows + r.Panes + r.Tabs + r.Tools }

// isUUIDForm은 canonical 8-4-4-4-12 형태인지만 본다 (FR-MGU-3). 헥사 여부까지
// 검사하지 않는 것은 `workspace.isUUIDForm` 과 같은 이유다 — 길이만 우연히 같은
// 입력을 막을 이득보다 규칙이 갈리는 손해가 크다.
func isUUIDForm(s string) bool {
	if len(s) != 36 {
		return false
	}
	return s[8] == '-' && s[13] == '-' && s[18] == '-' && s[23] == '-'
}

// RewriteIdentifiers는 workspace/tools 블롭의 구 식별자를 uuid 로 재작성한다
// (묶음 M, WORKSPACE_IDENTITY_SRS §3.5).
//
// 매핑을 먼저 완성한 뒤 일괄 치환한다 (FR-MGU-5) — `tools.json` 의 `id` 와
// `workspace.json` 의 `tabs[].toolId` 는 같은 매핑을 공유하고, 엔터티
// (창·분할 칸·탭)는 그와 분리된 매핑을 쓴다.
//
// 이미 uuid 형태인 id 는 재발급하지 않으므로 멱등하다 (FR-MGU-3). gen 은
// 결정적 테스트를 위해 주입한다 (FR-MGU-4).
func RewriteIdentifiers(workspaceBlob, toolsBlob []byte, gen func() string) ([]byte, []byte, IdentityReport, error) {
	var rep IdentityReport
	if gen == nil {
		gen = uuid.NewString
	}

	var ws map[string]interface{}
	if len(workspaceBlob) > 0 {
		if err := json.Unmarshal(workspaceBlob, &ws); err != nil {
			return nil, nil, rep, fmt.Errorf("workspace 파싱: %w", err)
		}
	}
	var tools []interface{}
	if len(toolsBlob) > 0 {
		if err := json.Unmarshal(toolsBlob, &tools); err != nil {
			return nil, nil, rep, fmt.Errorf("tools 파싱: %w", err)
		}
	}
	if ws == nil && tools == nil {
		return nil, nil, rep, nil
	}

	toolMap := map[string]string{}
	for _, raw := range tools {
		item, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if id, ok := item["id"].(string); ok && id != "" && !isUUIDForm(id) {
			toolMap[id] = gen()
		}
	}

	entityMap := map[string]string{}
	windows, _ := ws["windows"].([]interface{})
	for _, raw := range windows {
		win, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		claim(entityMap, win, "id", gen)
		if layout, ok := win["layout"].(map[string]interface{}); ok {
			walkNodes(layout, func(node map[string]interface{}) {
				claim(entityMap, node, "id", gen)
				for _, raw := range tabsOf(node) {
					claim(entityMap, raw, "id", gen)
				}
			})
		}
	}

	// ── 치환 ────────────────────────────────────────────────
	seen := map[string]struct{}{}
	dangle := func(old string) {
		if _, dup := seen[old]; dup {
			return
		}
		seen[old] = struct{}{}
		rep.Dangling = append(rep.Dangling, old)
	}
	// 참조는 매핑에 있을 때만 바꾼다. 구 형식인데 매핑에 없으면 끊어진 참조다
	// (FR-MGU-6). 이미 uuid 인 참조는 매핑에 없는 것이 정상이므로 보고하지 않는다.
	ref := func(m map[string]interface{}, key string, table map[string]string) {
		old, ok := m[key].(string)
		if !ok || old == "" {
			return
		}
		if nw, ok := table[old]; ok {
			m[key] = nw
			return
		}
		if !isUUIDForm(old) {
			dangle(old)
		}
	}

	for _, raw := range tools {
		item, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if id, ok := item["id"].(string); ok {
			if nw, ok := toolMap[id]; ok {
				item["id"] = nw
				rep.Tools++
			}
		}
	}

	ref(ws, "activeWindow", entityMap)
	if order, ok := ws["agentsOrder"].([]interface{}); ok {
		for i, raw := range order {
			old, ok := raw.(string)
			if !ok || old == "" {
				continue
			}
			if nw, ok := toolMap[old]; ok {
				order[i] = nw
				continue
			}
			if !isUUIDForm(old) {
				dangle(old)
			}
		}
	}

	for _, raw := range windows {
		win, ok := raw.(map[string]interface{})
		if !ok {
			continue
		}
		if apply(entityMap, win, "id") {
			rep.Windows++
		}
		ref(win, "focusedPane", entityMap)
		layout, ok := win["layout"].(map[string]interface{})
		if !ok {
			continue
		}
		walkNodes(layout, func(node map[string]interface{}) {
			if apply(entityMap, node, "id") {
				rep.Panes++
			}
			ref(node, "activeTab", entityMap)
			for _, tab := range tabsOf(node) {
				if apply(entityMap, tab, "id") {
					rep.Tabs++
				}
				ref(tab, "toolId", toolMap)
			}
		})
	}

	var wsOut, toolsOut []byte
	var err error
	if ws != nil {
		if wsOut, err = json.Marshal(ws); err != nil {
			return nil, nil, rep, fmt.Errorf("workspace 직렬화: %w", err)
		}
	}
	if tools != nil {
		if toolsOut, err = json.Marshal(tools); err != nil {
			return nil, nil, rep, fmt.Errorf("tools 직렬화: %w", err)
		}
	}
	return wsOut, toolsOut, rep, nil
}

// claim은 m[key] 가 구 형식 식별자면 매핑에 새 uuid 를 예약한다.
func claim(table map[string]string, m map[string]interface{}, key string, gen func() string) {
	id, ok := m[key].(string)
	if !ok || id == "" || isUUIDForm(id) {
		return
	}
	if _, dup := table[id]; dup {
		return
	}
	table[id] = gen()
}

// apply는 예약된 매핑을 실제로 반영하고 반영 여부를 돌려준다.
func apply(table map[string]string, m map[string]interface{}, key string) bool {
	id, ok := m[key].(string)
	if !ok {
		return false
	}
	nw, ok := table[id]
	if !ok {
		return false
	}
	m[key] = nw
	return true
}

// tabsOf는 노드의 탭 목록을 map 슬라이스로 돌려준다.
func tabsOf(node map[string]interface{}) []map[string]interface{} {
	raw, ok := node["tabs"].([]interface{})
	if !ok {
		return nil
	}
	out := make([]map[string]interface{}, 0, len(raw))
	for _, r := range raw {
		if tab, ok := r.(map[string]interface{}); ok {
			out = append(out, tab)
		}
	}
	return out
}

// walkNodes는 레이아웃 트리를 전위 순회하며 각 노드에 fn 을 적용한다.
func walkNodes(node map[string]interface{}, fn func(map[string]interface{})) {
	fn(node)
	children, ok := node["children"].([]interface{})
	if !ok {
		return
	}
	for _, raw := range children {
		if child, ok := raw.(map[string]interface{}); ok {
			walkNodes(child, fn)
		}
	}
}
