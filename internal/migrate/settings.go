package migrate

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// shortcutRenames는 v2 어휘로 바뀌는 단축키 action id 다 (FR-EM-6a).
// paneUp/paneDown/paneLeft/paneRight 는 분할 칸 이동이므로 새 어휘에서 이미
// 정확하여 목록에 없다.
var shortcutRenames = map[string]string{
	"sessionNext":  "windowNext",
	"sessionPrev":  "windowPrev",
	"newSession":   "newWindow",
	"closeSession": "closeWindow",
}

// Settings는 settings.json 을 v2 어휘로 변환한다. 개명된 단축키 id 목록을
// 함께 반환한다.
//
// 단축키 id 는 사용자 커스텀 바인딩의 키다 — 코드만 개명하면 기존 항목이
// 무시되어 바인딩이 조용히 기본값으로 돌아간다. layoutPresets 는 레이아웃
// 트리를 담으므로 region -> pane 도 함께 변환한다.
//
// 멱등하다: 구 키가 없으면 아무것도 바꾸지 않고 빈 목록을 반환한다.
func Settings(blob []byte) ([]byte, []string, error) {
	if len(strings.TrimSpace(string(blob))) == 0 {
		return nil, nil, nil
	}
	var m map[string]interface{}
	if err := json.Unmarshal(blob, &m); err != nil {
		return nil, nil, fmt.Errorf("settings 파싱: %w", err)
	}

	var renamed []string
	if sc, ok := m["shortcuts"].(map[string]interface{}); ok {
		for old, neu := range shortcutRenames {
			v, present := sc[old]
			if !present {
				continue
			}
			// 신 키가 이미 있으면 그것을 존중한다 (사용자가 재설정한 경우).
			if _, dup := sc[neu]; !dup {
				sc[neu] = v
			}
			delete(sc, old)
			renamed = append(renamed, old+" -> "+neu)
		}
		sort.Strings(renamed)
	}

	if presets, ok := m["layoutPresets"].([]interface{}); ok {
		for _, raw := range presets {
			p, ok := raw.(map[string]interface{})
			if !ok {
				continue
			}
			if layout, ok := p["layout"].(map[string]interface{}); ok {
				convertLayout(layout, false)
			}
		}
	}

	out, err := json.Marshal(m)
	if err != nil {
		return nil, nil, fmt.Errorf("settings 직렬화: %w", err)
	}
	return out, renamed, nil
}
