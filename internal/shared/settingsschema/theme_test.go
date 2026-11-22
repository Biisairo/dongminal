package settingsschema_test

import (
	"io"
	"regexp"
	"strings"
	"testing"

	"dongminal/internal/shared/settingsschema"
	"dongminal/web"
)

// QUALITY_GO_SRS TC-QG-10: `customTheme` 은 키별로 본다 (FR-QG-10). 색 규칙은 클라이언트
// `THEME_COLOR_RE`(`web/js/core/theme-vars.js`)와 같다.
func TestCheckThemeBlob(t *testing.T) {
	cases := []struct {
		name string
		blob string
		bad  string // 비면 통과, 아니면 Problem.Key 가 이것
	}{
		{"정상", `{"customTheme":{"mode":"dark","ui":{"bg":"#1a1b26","accent":"#7AA2F7cc"},"terminal":{"red":"#f7768e"}}}`, ""},
		{"null", `{"customTheme":null}`, ""},
		{"없음", `{"themeName":"Dracula"}`, ""},
		{"객체 아님 블롭", `[1]`, ""},
		{"위쪽 키는 보지 않는다", `{"customTheme":{"name":"x","ui":{}}}`, ""},
		{"따옴표", `{"customTheme":{"ui":{"bg":"red\"><img src=x onerror=alert(1)>"}}}`, "customTheme.ui.bg"},
		{"url", `{"customTheme":{"terminal":{"background":"url(https://x/y)"}}}`, "customTheme.terminal.background"},
		{"짧은 hex", `{"customTheme":{"ui":{"bg":"#fff"}}}`, "customTheme.ui.bg"},
		{"숫자", `{"customTheme":{"ui":{"bg":1}}}`, "customTheme.ui.bg"},
		{"ui 가 문자열", `{"customTheme":{"ui":"nope"}}`, "customTheme.ui"},
		{"mode 이상", `{"customTheme":{"mode":"<b>"}}`, "customTheme.mode"},
		{"객체 아님", `{"customTheme":"x"}`, "customTheme"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := settingsschema.CheckThemeBlob([]byte(tc.blob))
			switch {
			case tc.bad == "" && p != nil:
				t.Fatalf("통과해야 한다: %v", p)
			case tc.bad != "" && (p == nil || p.Key != tc.bad):
				t.Fatalf("Problem = %v, want key %s", p, tc.bad)
			}
		})
	}
}

// FR-QG-10: `dongminal config` 의 검증(Validate)도 같은 규칙이다.
func TestValidateCustomTheme(t *testing.T) {
	specs, err := settingsschema.Load()
	if err != nil {
		t.Fatal(err)
	}
	probs, _, err := settingsschema.Validate(specs, []byte(`{"customTheme":{"ui":{"bg":"red"}}}`))
	if err != nil || len(probs) != 1 || probs[0].Key != "customTheme.ui.bg" {
		t.Fatalf("probs=%v err=%v", probs, err)
	}
}

// TC-QG-10 · FR-QG-13: 내장 테마 54종의 값은 모두 통과한다. 원천은 embed 된 `js/ui/themes.js` 다.
func TestBuiltinThemesPass(t *testing.T) {
	f, err := web.FS().Open("js/ui/themes.js")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	src, err := io.ReadAll(f)
	if err != nil {
		t.Fatal(err)
	}
	section := regexp.MustCompile(`(?m)^\s+(ui|terminal):\{([^}]*)\}`)
	pair := regexp.MustCompile(`(\w+):'([^']*)'`)
	mode := regexp.MustCompile(`mode:'(\w+)'`)
	modes := mode.FindAllSubmatch(src, -1)
	secs := section.FindAllSubmatch(src, -1)
	if len(modes) != 54 || len(secs) != 108 {
		t.Fatalf("테마 %d · 칸 %d — want 54 · 108", len(modes), len(secs))
	}
	for i := range modes {
		var b strings.Builder
		b.WriteString(`{"customTheme":{"mode":"` + string(modes[i][1]) + `"`)
		for _, s := range secs[2*i : 2*i+2] {
			b.WriteString(`,"` + string(s[1]) + `":{`)
			for j, p := range pair.FindAllSubmatch(s[2], -1) {
				if j > 0 {
					b.WriteString(",")
				}
				b.WriteString(`"` + string(p[1]) + `":"` + string(p[2]) + `"`)
			}
			b.WriteString("}")
		}
		b.WriteString("}}")
		if p := settingsschema.CheckThemeBlob([]byte(b.String())); p != nil {
			t.Fatalf("내장 테마 %d: %v\n%s", i, p, b.String())
		}
	}
}
