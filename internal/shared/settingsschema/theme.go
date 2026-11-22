package settingsschema

import (
	"encoding/json"
	"regexp"
	"sort"
)

// 사용자 정의 테마의 값 검증 (QUALITY_GO_SRS FR-QG-10 · PROD3 FC-F1 서버 쪽).
//
// 표의 서술자는 `customTheme` 을 `object` 라고만 말한다. 화면은 그 값을 테마 미리보기의
// 스타일에 넣으므로 색이 아닌 값(따옴표·`url(…)`)은 마크업이 될 수 있었고, 서버가 그
// 블롭을 다른 기기로 방송한다. 화면은 읽을 때 거른다(`sanitizeCustomTheme`,
// REFACTOR3_DEFECTS_SRS FR-RD3-1). 여기는 같은 규칙으로 들어오는 쪽을 막는다.
//
// **키 이름은 묻지 않는다** (D-QG-5) — 클라이언트도 값만 본다. 키 목록을 여기 따로 들면
// 두 벌이 된다.

// CustomThemeKey 는 사용자 정의 테마의 블롭 키다.
const CustomThemeKey = "customTheme"

// themeColor 는 클라이언트 `THEME_COLOR_RE`(`web/js/core/theme-vars.js`)와 같은 규칙이다.
var themeColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$`)

// themeSections 는 색 표를 담는 칸이다. 클라이언트 `sanitizeCustomTheme` 이 읽는 둘이다.
var themeSections = []string{"ui", "terminal"}

// checkCustomTheme 은 `customTheme` 값 하나를 본다. nil 이면 통과다.
func checkCustomTheme(v any) *Problem {
	if v == nil {
		return nil
	}
	t, ok := v.(map[string]any)
	if !ok {
		return &Problem{CustomThemeKey, "object 여야 합니다", v}
	}
	if m, ok := t["mode"]; ok && m != "dark" && m != "light" {
		return &Problem{CustomThemeKey + ".mode", `"dark" 또는 "light" 여야 합니다`, m}
	}
	for _, sec := range themeSections {
		raw, ok := t[sec]
		if !ok {
			continue
		}
		colors, ok := raw.(map[string]any)
		if !ok {
			return &Problem{CustomThemeKey + "." + sec, "object 여야 합니다", raw}
		}
		keys := make([]string, 0, len(colors))
		for k := range colors {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if s, ok := colors[k].(string); !ok || !themeColor.MatchString(s) {
				return &Problem{CustomThemeKey + "." + sec + "." + k, "#rrggbb 또는 #rrggbbaa 색이어야 합니다", colors[k]}
			}
		}
	}
	return nil
}

// CheckThemeBlob 은 설정 블롭의 `customTheme` 만 본다 — `PUT /api/settings` 가 부른다
// (FR-QG-11). 블롭이 객체가 아니거나 키가 없으면 통과다. 블롭이 JSON 인지는 부르는 쪽이 본다.
func CheckThemeBlob(blob []byte) *Problem {
	var m map[string]json.RawMessage
	if json.Unmarshal(blob, &m) != nil {
		return nil
	}
	raw, ok := m[CustomThemeKey]
	if !ok {
		return nil
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return nil
	}
	return checkCustomTheme(v)
}
