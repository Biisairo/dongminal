package serverconf_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/serverconf"
)

var bindEnv = map[string]string{"DONGMINAL_HOST": "2.2.2.2", "DONGMINAL_PORT": "4444", "PORT": "5555"}

// TC-HRB-1 (FR-HRB-1): 바인드 환경 변수는 바인드를 정하지 않는다. 파일이 있으면
// 파일, 없으면 기본값이다.
func TestBindEnvIgnored(t *testing.T) {
	home := t.TempDir()
	write(t, home, `{"host":"10.0.0.1","port":"3333"}`)
	got := serverconf.Resolve(serverconf.Inputs{Home: home, Getenv: envOf(bindEnv)})
	if got.Host.Value != "10.0.0.1" || got.Host.Source != serverconf.SourceFile {
		t.Errorf("host = %+v", got.Host)
	}
	if got.Port.Value != "3333" || got.Port.Source != serverconf.SourceFile {
		t.Errorf("port = %+v", got.Port)
	}

	got = serverconf.Resolve(serverconf.Inputs{Home: t.TempDir(), Getenv: envOf(bindEnv)})
	if got.Host.Value != dmenv.DefaultHost || got.Host.Source != serverconf.SourceDefault {
		t.Errorf("host = %+v", got.Host)
	}
	if got.Port.Value != dmenv.DefaultPort || got.Port.Source != serverconf.SourceDefault {
		t.Errorf("port = %+v", got.Port)
	}
}

// TC-HRB-1 (FR-HRB-8): 바인드 환경 변수가 있으면 경고 한 줄. 없으면 빈 문자열.
func TestBindEnvWarning(t *testing.T) {
	got := serverconf.Resolve(serverconf.Inputs{Home: t.TempDir(), Getenv: envOf(bindEnv)})
	w := got.BindEnvWarning()
	for _, want := range []string{"DONGMINAL_HOST", "DONGMINAL_PORT", "PORT", "server.json"} {
		if !contains(w, want) {
			t.Errorf("경고에 %q 가 없다: %q", want, w)
		}
	}
	if w := serverconf.Resolve(serverconf.Inputs{Home: t.TempDir(), Getenv: envOf(nil)}).BindEnvWarning(); w != "" {
		t.Errorf("환경 변수가 없는데 경고가 났다: %q", w)
	}
	// 빈 값은 설정되지 않은 것이다.
	empty := map[string]string{"DONGMINAL_HOST": "", "DONGMINAL_PORT": "", "PORT": ""}
	if w := serverconf.Resolve(serverconf.Inputs{Home: t.TempDir(), Getenv: envOf(empty)}).BindEnvWarning(); w != "" {
		t.Errorf("빈 환경 변수에 경고가 났다: %q", w)
	}
}

// TC-HRB-1 (FR-HRB-2): 파일의 틀린 포트는 기동을 막지 않는다 — 경고하고 기본값을 쓴다.
func TestFileBadPortFallsBackToDefault(t *testing.T) {
	for _, body := range []string{`{"port":"zzz"}`, `{"port":"99999"}`, `{"port":"0"}`} {
		home := t.TempDir()
		write(t, home, body)
		got := serverconf.Resolve(serverconf.Inputs{Home: home, Getenv: envOf(nil)})
		if err := got.Err(); err != nil {
			t.Errorf("%s: 기동을 막았다: %v", body, err)
		}
		if got.Port.Value != dmenv.DefaultPort || got.Port.Source != serverconf.SourceDefault {
			t.Errorf("%s: port = %+v", body, got.Port)
		}
		if len(got.Warnings) == 0 {
			t.Errorf("%s: 경고가 없다", body)
		}
	}
}

func readJSON(t *testing.T, home string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, serverconf.FileName))
	if err != nil {
		t.Fatal(err)
	}
	m := map[string]any{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("%v: %s", err, data)
	}
	return m
}

// TC-HRB-2 (FR-HRB-3): SetBind 는 준 값만 쓰고 다른 키를 보존한다. 권한은 0600.
func TestSetBind(t *testing.T) {
	home := t.TempDir()
	write(t, home, `{"host":"127.0.0.1","logLevel":"debug","futureKey":1}`)
	if err := serverconf.SetBind(home, "", "9100"); err != nil {
		t.Fatal(err)
	}
	m := readJSON(t, home)
	if m["port"] != "9100" || m["host"] != "127.0.0.1" || m["logLevel"] != "debug" || m["futureKey"] != float64(1) {
		t.Errorf("파일 = %v", m)
	}
	if err := serverconf.SetBind(home, "0.0.0.0", ""); err != nil {
		t.Fatal(err)
	}
	m = readJSON(t, home)
	if m["host"] != "0.0.0.0" || m["port"] != "9100" {
		t.Errorf("파일 = %v", m)
	}
	st, err := os.Stat(filepath.Join(home, serverconf.FileName))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Errorf("권한 = %v", st.Mode().Perm())
	}
	got := serverconf.Resolve(serverconf.Inputs{Home: home, Getenv: envOf(nil)})
	if got.Host.Value != "0.0.0.0" || got.Port.Value != "9100" {
		t.Errorf("다시 읽은 값 = %+v %+v", got.Host, got.Port)
	}
}

// 파일이 없거나 깨졌어도 쓴다 (D-CFG-3 — 편의 파일이다).
func TestSetBindOnMissingOrCorruptFile(t *testing.T) {
	home := filepath.Join(t.TempDir(), "new")
	if err := serverconf.SetBind(home, "", "9101"); err != nil {
		t.Fatal(err)
	}
	if m := readJSON(t, home); m["port"] != "9101" {
		t.Errorf("파일 = %v", m)
	}
	home = t.TempDir()
	write(t, home, `{nope`)
	if err := serverconf.SetBind(home, "", "9102"); err != nil {
		t.Fatal(err)
	}
	if m := readJSON(t, home); m["port"] != "9102" {
		t.Errorf("파일 = %v", m)
	}
	if err := serverconf.SetBind("", "", "9103"); err == nil {
		t.Error("홈 없이 썼다")
	}
}

// TC-HRB-2: SetBind 와 SetUpdateCheck 가 서로의 키를 지우지 않는다.
func TestSetBindKeepsUpdateCheck(t *testing.T) {
	home := t.TempDir()
	if err := serverconf.SetUpdateCheck(home, false); err != nil {
		t.Fatal(err)
	}
	if err := serverconf.SetBind(home, "0.0.0.0", "9104"); err != nil {
		t.Fatal(err)
	}
	got := serverconf.Resolve(serverconf.Inputs{Home: home, Getenv: envOf(nil)})
	if got.UpdateCheck || !got.UpdateCheckSet {
		t.Errorf("updateCheck 가 사라졌다: %+v", got)
	}
}

// FR-HRB-7: 주소 파일 읽기. 없거나 틀리면 ok=false.
func TestReadAddr(t *testing.T) {
	home := t.TempDir()
	if _, _, ok := serverconf.ReadAddr(home); ok {
		t.Error("없는 파일이 ok")
	}
	writeAddr := func(body string) {
		if err := os.WriteFile(filepath.Join(home, serverconf.AddrFileName), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		body, host, port string
		ok               bool
	}{
		{"127.0.0.1:9200\n", "127.0.0.1", "9200", true},
		{"0.0.0.0:9201", "0.0.0.0", "9201", true},
		{"[::1]:9202\n", "::1", "9202", true},
		{"garbage", "", "", false},
		{"127.0.0.1:abc", "", "", false},
		{"127.0.0.1:99999", "", "", false},
		{"", "", "", false},
	} {
		writeAddr(tc.body)
		h, p, ok := serverconf.ReadAddr(home)
		if ok != tc.ok || h != tc.host || p != tc.port {
			t.Errorf("%q → %q %q %v", tc.body, h, p, ok)
		}
	}
	if _, _, ok := serverconf.ReadAddr(""); ok {
		t.Error("빈 홈이 ok")
	}
}
