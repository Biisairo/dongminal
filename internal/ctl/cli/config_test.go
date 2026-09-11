package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// CONFIG_MANAGEMENT_SRS §4.4 — `dongminal config`.

func writeServerJSON(t *testing.T, home, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(home, "server.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// 이 패키지의 검사는 **도구 셸 안에서** 돈다. 그 셸에는 사용자의 실제 인스턴스를
// 가리키는 `DONGMINAL_*` 가 심겨 있고(`toolhub.StartTool`), 그것이 새어 들면 검사는
// 자기 것이 아닌 값을 잰다 — 이 저장소가 `ui-layout-defaults` 에서 비싸게 배운
// 자리다. **검사가 자기 전제를 스스로 세운다.**
func isolateEnv(t *testing.T, home string) {
	t.Helper()
	t.Setenv(EnvHome, home)
	for _, k := range []string{EnvHost, "PORT", "DONGMINAL_PORT", "DONGMINAL_LOG", "DONGMINAL_LOG_LEVEL"} {
		t.Setenv(k, "")
	}
}

func writeSettingsJSON(t *testing.T, home, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(home, "settings.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TC-CFG-11: `config show` 는 값과 **출처**를 함께 낸다.
// 안 듣는 설정을 쫓는 사람이 묻는 것이 그것이다 (FR-CFG-7).
func TestConfigShowCarriesSource(t *testing.T) {
	home := t.TempDir()
	writeServerJSON(t, home, `{"host":"10.0.0.1"}`)
	isolateEnv(t, home)
	t.Setenv("PORT", "4321")

	var out, errw bytes.Buffer
	o, err := ParseConfig([]string{"show"})
	if err != nil {
		t.Fatal(err)
	}
	if code := RunConfig(o, &out, &errw); code != 0 {
		t.Fatalf("exit %d: %s", code, errw.String())
	}
	s := out.String()
	for _, want := range []string{"host", "10.0.0.1", "file", "port", "4321", "env", "logLevel", "info", "default"} {
		if !strings.Contains(s, want) {
			t.Errorf("출력에 %q 가 없다:\n%s", want, s)
		}
	}
}

// TC-CFG-15: `--json` 은 기계가 읽는 형태다.
func TestConfigShowJSON(t *testing.T) {
	home := t.TempDir()
	isolateEnv(t, home)
	var out, errw bytes.Buffer
	o, _ := ParseConfig([]string{"show", "--json"})
	if code := RunConfig(o, &out, &errw); code != 0 {
		t.Fatalf("exit %d: %s", code, errw.String())
	}
	var m map[string]any
	if err := json.Unmarshal(out.Bytes(), &m); err != nil {
		t.Fatalf("JSON 이 아니다: %v\n%s", err, out.String())
	}
	if _, ok := m["server"]; !ok {
		t.Errorf("server 절이 없다: %v", m)
	}
}

// TC-CFG-12·14: 범위 밖 값을 잡고 **첫 오류에서 멈추지 않는다**.
func TestConfigValidateReportsAllAndFails(t *testing.T) {
	home := t.TempDir()
	writeSettingsJSON(t, home, `{"tabWidthPx":9999,"focusEdgeLevel":-3,"attnEdgeLevel":77}`)
	isolateEnv(t, home)

	var out, errw bytes.Buffer
	o, _ := ParseConfig([]string{"validate"})
	code := RunConfig(o, &out, &errw)
	if code != 1 {
		t.Fatalf("exit = %d, 기대 1", code)
	}
	s := out.String() + errw.String()
	for _, want := range []string{"tabWidthPx", "focusEdgeLevel", "attnEdgeLevel"} {
		if !strings.Contains(s, want) {
			t.Errorf("%q 가 보고되지 않았다:\n%s", want, s)
		}
	}
}

// TC-CFG-13: 알 수 없는 키는 **경고이며 exit 0** (FR-CFG-9 / D-CFG-4).
func TestConfigValidateUnknownKeyIsWarning(t *testing.T) {
	home := t.TempDir()
	writeSettingsJSON(t, home, `{"futureKey":1,"pageTitle":"x"}`)
	isolateEnv(t, home)
	var out, errw bytes.Buffer
	o, _ := ParseConfig([]string{"validate"})
	if code := RunConfig(o, &out, &errw); code != 0 {
		t.Fatalf("exit = %d, 기대 0\n%s%s", code, out.String(), errw.String())
	}
	if !strings.Contains(out.String()+errw.String(), "futureKey") {
		t.Errorf("경고가 나오지 않았다")
	}
}

// 깨진 `server.json` 은 **막지 않는다** (FR-CFG-15 / D-CFG-3).
func TestConfigShowSurvivesCorruptServerJSON(t *testing.T) {
	home := t.TempDir()
	writeServerJSON(t, home, `{nope`)
	isolateEnv(t, home)
	var out, errw bytes.Buffer
	o, _ := ParseConfig([]string{"show"})
	if code := RunConfig(o, &out, &errw); code != 0 {
		t.Fatalf("깨진 파일이 기동 경로를 막았다: exit %d", code)
	}
	if !strings.Contains(out.String()+errw.String(), "server.json") {
		t.Errorf("경고가 없다:\n%s%s", out.String(), errw.String())
	}
}

// 파일이 전부 정상이면 조용히 통과한다.
func TestConfigValidateCleanPasses(t *testing.T) {
	home := t.TempDir()
	writeSettingsJSON(t, home, `{"tabWidthPx":200,"pageTitle":"hi"}`)
	writeServerJSON(t, home, `{"port":"8080"}`)
	isolateEnv(t, home)
	var out, errw bytes.Buffer
	o, _ := ParseConfig([]string{"validate"})
	if code := RunConfig(o, &out, &errw); code != 0 {
		t.Fatalf("exit %d\n%s%s", code, out.String(), errw.String())
	}
}

// 알 수 없는 서브커맨드는 사용법으로 떨어진다.
func TestConfigUnknownSubcommand(t *testing.T) {
	if _, err := ParseConfig([]string{"nope"}); err == nil {
		t.Fatal("알 수 없는 서브커맨드가 통과했다")
	}
}

// TC-CFG-16: `PORT=abc` 는 `net.Listen` 전에 거부되고 문구에 변수와 값이 실린다.
func TestConfigValidateCatchesBadPort(t *testing.T) {
	home := t.TempDir()
	isolateEnv(t, home)
	t.Setenv("PORT", "abc")
	var out, errw bytes.Buffer
	o, _ := ParseConfig([]string{"validate"})
	if code := RunConfig(o, &out, &errw); code != 1 {
		t.Fatalf("exit = %d, 기대 1", code)
	}
	s := out.String() + errw.String()
	if !strings.Contains(s, "PORT") || !strings.Contains(s, "abc") {
		t.Errorf("문구에 변수와 값이 없다:\n%s", s)
	}
}
