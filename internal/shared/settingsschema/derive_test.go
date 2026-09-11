package settingsschema_test

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"dongminal/internal/shared/settingsschema"
)

// TC-CFG-1 — **세 표의 키 집합이 같다** (CONFIG_MANAGEMENT_SRS FR-CFG-4·5).
//
// 종전에는 이 목록이 세 벌이었고 **아무 게이트도 없었다**. 키를 더하고 한 곳을
// 잊은 실패는 다른 브라우저 창을 열어 보기 전까지 아무도 모른다.
//
// 검사가 소스를 읽는 이유는 브라우저 없이 돌기 위해서다 — 이 저장소의 e2e 는
// 무겁고, 이 계약은 **커밋 전에** 깨져야 한다.
func TestSchemaAndAccessKeysMatch(t *testing.T) {
	specs, err := settingsschema.Load()
	if err != nil {
		t.Fatal(err)
	}
	schemaKeys := settingsschema.Keys(specs)

	src, err := os.ReadFile("../../../web/js/core/app-settings.js")
	if err != nil {
		t.Fatal(err)
	}
	accessKeys := accessTableKeys(t, string(src))

	if strings.Join(schemaKeys, ",") != strings.Join(accessKeys, ",") {
		t.Fatalf("키 집합이 갈렸다\n  SETTINGS_SCHEMA: %v\n  SETTINGS_ACCESS: %v", schemaKeys, accessKeys)
	}
}

// `_saveSettings` 가 표를 돌아야 한다 — 인라인 나열로 되돌아가면 여기서 잡힌다.
func TestSaveSettingsDerivesFromTable(t *testing.T) {
	src, err := os.ReadFile("../../../web/js/core/app-settings.js")
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)
	body := between(s, "async _saveSettings(){", "\n  },")
	if body == "" {
		t.Fatal("_saveSettings 를 찾지 못했다")
	}
	if !strings.Contains(body, "for(const spec of SETTINGS_SCHEMA)") {
		t.Error("_saveSettings 가 서술자 표를 돌지 않는다 (FR-CFG-4)")
	}
	// 인라인 나열의 흔적 — 옛 형태가 되살아나면 잡는다.
	for _, k := range []string{"gitConsoleInterval,", "focusEdgeLevel,attnEdgeLevel"} {
		if strings.Contains(body, k) {
			t.Errorf("키를 인라인으로 나열하고 있다: %q", k)
		}
	}
}

// SETTINGS_ACCESS 의 최상위 키를 뽑는다. 표가 `키:{...}` 한 줄씩이라는 형태에
// 기댄다 — 어긋나면 위 검사가 키 수 차이로 먼저 운다.
func accessTableKeys(t *testing.T, src string) []string {
	t.Helper()
	body := between(src, "const SETTINGS_ACCESS={", "\n};")
	if body == "" {
		t.Fatal("SETTINGS_ACCESS 를 찾지 못했다")
	}
	re := regexp.MustCompile(`(?m)^  ([A-Za-z_$][\w$]*):\{`)
	var out []string
	for _, m := range re.FindAllStringSubmatch(body, -1) {
		out = append(out, m[1])
	}
	sort.Strings(out)
	return out
}

func between(s, open, close string) string {
	i := strings.Index(s, open)
	if i < 0 {
		return ""
	}
	i += len(open)
	j := strings.Index(s[i:], close)
	if j < 0 {
		return ""
	}
	return s[i : i+j]
}
