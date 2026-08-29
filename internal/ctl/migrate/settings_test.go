package migrate

import (
	"encoding/json"
	"reflect"
	"testing"
)

// v1Settings: 구 단축키 id + region 타입을 담은 레이아웃 프리셋.
const v1Settings = `{
  "themeName": "nord",
  "statsInterval": 3000,
  "statusBar": {"connection": true, "location": true},
  "shortcuts": {
    "sessionNext": "Alt+Comma", "sessionPrev": "Alt+KeyM",
    "newSession": "Ctrl+Shift+KeyN", "closeSession": "Ctrl+Shift+KeyW",
    "newTab": "Ctrl+Shift+KeyT", "tabNext": "Ctrl+Tab",
    "paneUp": "Ctrl+Shift+ArrowUp", "splitH": "Ctrl+Shift+KeyH"
  },
  "layoutPresets": [
    {"name": "2x1", "layout": {"type": "split", "direction": "horizontal",
      "children": [{"type": "region", "tabCount": 1}, {"type": "region", "tabCount": 2}]}},
    {"name": "single", "layout": {"type": "region", "tabCount": 1}}
  ],
  "defaultPreset": 0
}`

func TestSettings_RenamesShortcutIDs(t *testing.T) {
	out, rep, err := Settings([]byte(v1Settings))
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	var m map[string]interface{}
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("파싱: %v", err)
	}
	sc := m["shortcuts"].(map[string]interface{})

	for _, old := range []string{"sessionNext", "sessionPrev", "newSession", "closeSession"} {
		if _, ok := sc[old]; ok {
			t.Errorf("구 단축키 id 가 남아 있음: %s", old)
		}
	}
	want := map[string]string{
		"windowNext": "Alt+Comma", "windowPrev": "Alt+KeyM",
		"newWindow": "Ctrl+Shift+KeyN", "closeWindow": "Ctrl+Shift+KeyW",
	}
	for k, v := range want {
		if sc[k] != v {
			t.Errorf("shortcuts[%s] = %#v, want %q — 사용자 바인딩 소실", k, sc[k], v)
		}
	}
	// 변경되지 않아야 하는 것들.
	for k, v := range map[string]string{
		"newTab": "Ctrl+Shift+KeyT", "tabNext": "Ctrl+Tab",
		"paneUp": "Ctrl+Shift+ArrowUp", "splitH": "Ctrl+Shift+KeyH",
	} {
		if sc[k] != v {
			t.Errorf("shortcuts[%s] 가 변경됨: %#v", k, sc[k])
		}
	}
	if len(rep) != 4 {
		t.Errorf("보고된 개명 수 = %d, want 4 (%v)", len(rep), rep)
	}
}

func TestSettings_ConvertsPresetLayoutRegionToPane(t *testing.T) {
	out, _, err := Settings([]byte(v1Settings))
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	var m map[string]interface{}
	json.Unmarshal(out, &m)
	presets := m["layoutPresets"].([]interface{})

	var types []string
	var walk func(n map[string]interface{})
	walk = func(n map[string]interface{}) {
		types = append(types, n["type"].(string))
		if ch, ok := n["children"].([]interface{}); ok {
			for _, c := range ch {
				walk(c.(map[string]interface{}))
			}
		}
	}
	for _, p := range presets {
		walk(p.(map[string]interface{})["layout"].(map[string]interface{}))
	}
	want := []string{"split", "pane", "pane", "pane"}
	if !reflect.DeepEqual(types, want) {
		t.Errorf("프리셋 layout type = %v, want %v", types, want)
	}
}

func TestSettings_PreservesUnrelatedKeys(t *testing.T) {
	out, _, err := Settings([]byte(v1Settings))
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	var m map[string]interface{}
	json.Unmarshal(out, &m)
	if m["themeName"] != "nord" {
		t.Errorf("themeName 소실: %#v", m["themeName"])
	}
	if v, _ := m["statsInterval"].(float64); int(v) != 3000 {
		t.Errorf("statsInterval 소실: %#v", m["statsInterval"])
	}
	sb, ok := m["statusBar"].(map[string]interface{})
	if !ok || sb["location"] != true {
		t.Errorf("statusBar 소실: %#v", m["statusBar"])
	}
	if v, _ := m["defaultPreset"].(float64); int(v) != 0 {
		t.Errorf("defaultPreset 소실: %#v", m["defaultPreset"])
	}
	if presets, ok := m["layoutPresets"].([]interface{}); !ok || len(presets) != 2 {
		t.Errorf("layoutPresets 개수 변화: %#v", m["layoutPresets"])
	} else if presets[0].(map[string]interface{})["name"] != "2x1" {
		t.Errorf("프리셋 이름 소실")
	}
}

func TestSettings_IsIdempotent(t *testing.T) {
	first, rep1, err := Settings([]byte(v1Settings))
	if err != nil {
		t.Fatalf("1차: %v", err)
	}
	// 2차에는 바꿀 것이 남아 있지 않다 — 그것이 멱등의 의미이며, 산출물이
	// 없어야 Apply 가 파일을 다시 쓰지 않는다.
	second, rep2, err := Settings(first)
	if err != nil {
		t.Fatalf("2차: %v", err)
	}
	if second != nil {
		t.Errorf("재실행이 산출물을 냄: %s", second)
	}
	if len(rep1) == 0 {
		t.Error("1차에서 개명이 보고되지 않음")
	}
	if len(rep2) != 0 {
		t.Errorf("2차에서 개명이 보고됨: %v", rep2)
	}
}

func TestSettings_EmptyInputIsNoop(t *testing.T) {
	out, rep, err := Settings(nil)
	if err != nil {
		t.Fatalf("Settings(nil): %v", err)
	}
	if out != nil {
		t.Errorf("빈 입력에 산출물 생성: %s", out)
	}
	if len(rep) != 0 {
		t.Errorf("빈 입력에 개명 보고: %v", rep)
	}
}

func TestSettings_NoShortcutsKeyIsFine(t *testing.T) {
	out, rep, err := Settings([]byte(`{"themeName":"nord"}`))
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if out != nil {
		t.Errorf("바꿀 것이 없는데 산출물 생성: %s", out)
	}
	if len(rep) != 0 {
		t.Errorf("개명 보고: %v", rep)
	}
}

func TestSettings_InvalidJSONErrors(t *testing.T) {
	if _, _, err := Settings([]byte(`{"shortcuts":`)); err == nil {
		t.Error("깨진 JSON 에 오류가 없음")
	}
}

// Apply 가 settings.json 도 함께 처리하는지.
func TestApply_MigratesSettingsJSON(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", v1Basic)
	seed(t, dir, "panes.json", panesBasic)
	seed(t, dir, "settings.json", v1Settings)

	rep, err := Apply(dir, false)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if len(rep.ShortcutsRenamed) != 4 {
		t.Errorf("Report.ShortcutsRenamed = %v, want 4개", rep.ShortcutsRenamed)
	}
	if !exists(dir, "settings.json.v1.bak") {
		t.Error("settings 백업 미생성")
	}
	if got := read(t, dir, "settings.json.v1.bak"); got != v1Settings {
		t.Error("settings 백업이 원본과 다름")
	}
	var m map[string]interface{}
	json.Unmarshal([]byte(read(t, dir, "settings.json")), &m)
	sc := m["shortcuts"].(map[string]interface{})
	if sc["windowNext"] != "Alt+Comma" {
		t.Errorf("변환된 settings.json 에 windowNext 없음: %#v", sc)
	}
}

func TestApply_DryRunDoesNotTouchSettings(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", v1Basic)
	seed(t, dir, "settings.json", v1Settings)
	if _, err := Apply(dir, true); err != nil {
		t.Fatalf("dry-run: %v", err)
	}
	if got := read(t, dir, "settings.json"); got != v1Settings {
		t.Error("dry-run 이 settings.json 을 변경했음")
	}
	if exists(dir, "settings.json.v1.bak") {
		t.Error("dry-run 이 백업을 생성했음")
	}
}

func TestApply_NoSettingsFileIsFine(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "workspace.json", v1Basic)
	rep, err := Apply(dir, false)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if len(rep.ShortcutsRenamed) != 0 {
		t.Errorf("settings 없는데 개명 보고: %v", rep.ShortcutsRenamed)
	}
}

// v2Settings: 개명이 끝나고 프리셋 레이아웃도 pane 인 settings — 마이그레이션
// 대상이 하나도 없다.
const v2Settings = `{
  "themeName": "nord",
  "shortcuts": {
    "windowNext": "Alt+Comma", "newTab": "Ctrl+Shift+KeyT"
  },
  "layoutPresets": [
    {"name": "single", "layout": {"type": "pane", "tabCount": 1}}
  ]
}`

// 바꿀 것이 없으면 산출물도 없어야 한다. 그러지 않으면 Apply 가 "대상 없음" 을
// 찍으면서도 settings.json 을 재작성해 들여쓰기·키 순서를 파괴한다.
func TestSettings_NoChangeReturnsNilOutput(t *testing.T) {
	out, rep, err := Settings([]byte(v2Settings))
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if out != nil {
		t.Errorf("바꾼 것이 없는데 산출물 생성: %s", out)
	}
	if len(rep) != 0 {
		t.Errorf("개명 보고: %v", rep)
	}
}

// 단축키는 그대로인데 프리셋만 구식인 경우 — 변경이므로 산출물이 있어야 한다.
func TestSettings_PresetOnlyChangeStillEmits(t *testing.T) {
	out, rep, err := Settings([]byte(`{"layoutPresets":[{"name":"s","layout":{"type":"region"}}]}`))
	if err != nil {
		t.Fatalf("Settings: %v", err)
	}
	if out == nil {
		t.Fatal("프리셋이 변환됐는데 산출물이 없음")
	}
	if len(rep) != 0 {
		t.Errorf("단축키 개명이 없는데 보고됨: %v", rep)
	}
}

// Apply 수준: 마이그레이션 대상이 없으면 settings.json 이 바이트 단위로
// 그대로여야 하고 백업도 생기지 않아야 한다.
func TestApply_NoTargetLeavesSettingsUntouched(t *testing.T) {
	dir := t.TempDir()
	seed(t, dir, "settings.json", v2Settings)

	rep, err := Apply(dir, false)
	if err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if !rep.Empty {
		t.Errorf("대상이 없는데 Empty=false: %+v", rep)
	}
	if got := read(t, dir, "settings.json"); got != v2Settings {
		t.Errorf("settings.json 이 재작성됨:\n%s", got)
	}
	if exists(dir, "settings.json.v1.bak") {
		t.Error("대상이 없는데 .v1.bak 생성됨")
	}
}
