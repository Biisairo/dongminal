package cli

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/serverconf"
)

// HOT_REBIND_SRS 묶음 S — 바인드의 기준은 `server.json` 하나다.
//
// 모든 시험은 임시 홈과 빈 포트에서 돈다. 비격리 `RunStart` 는 그 포트를 비우려
// `killPort` 를 부르므로, 포트가 기본값(사용 중인 서버)으로 풀리지 않게 언제나 빈
// 포트를 파일이나 플래그로 준다.

// tempHome 은 사용 중인 홈 아래가 아닌 임시 홈이다.
func tempHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	if real, err := os.UserHomeDir(); err == nil && strings.HasPrefix(home, filepath.Join(real, dmenv.DefaultHomeDir)) {
		t.Fatalf("임시 홈이 사용 중인 홈 아래다: %s", home)
	}
	return home
}

func freePort(t *testing.T) string {
	t.Helper()
	p, err := FreePort()
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func readServerJSON(t *testing.T, home string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(home, serverconf.FileName))
	if err != nil {
		t.Fatal(err)
	}
	m := map[string]any{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// startForeground 는 serve 를 가로채 전경 기동을 돌리고, serve 가 받은 값을 준다.
func startForeground(t *testing.T, o StartOpts) (host, port, stderr string) {
	t.Helper()
	t.Setenv(EnvToolID, "")
	t.Setenv(EnvRestartRunner, "")
	t.Setenv(dmenv.EnvToolHome, "")
	o.Foreground = true
	var out, errb bytes.Buffer
	var served string
	serve := func(home, h, p string) int { served, host, port = home, h, p; return 0 }
	if code := RunStart(o, serve, &out, &errb); code != 0 {
		t.Fatalf("exit = %d: %s", code, errb.String())
	}
	if o.Isolated && o.Home == "" {
		t.Cleanup(func() { os.RemoveAll(served) })
	}
	return host, port, errb.String()
}

// TC-HRB-2 (FR-HRB-3): `--port` 는 server.json 에 쓰고 그 값으로 뜬다.
func TestStartPortFlagWritesServerJSON(t *testing.T) {
	home := tempHome(t)
	isolateEnv(t, home)
	writeServerJSON(t, home, `{"host":"127.0.0.1","logLevel":"debug"}`)
	p := freePort(t)

	_, got, _ := startForeground(t, StartOpts{Common: Common{Port: p, Home: home}})
	if got != p {
		t.Errorf("serve 포트 = %q want %q", got, p)
	}
	m := readServerJSON(t, home)
	if m["port"] != p || m["logLevel"] != "debug" {
		t.Errorf("server.json = %v", m)
	}
}

// TC-HRB-2 (FR-HRB-3): `--expose` 는 호스트를 쓰고, 주지 않은 `start` 는 파일의
// 호스트를 그대로 쓴다.
func TestStartExposeWritesAndPlainKeepsHost(t *testing.T) {
	home := tempHome(t)
	isolateEnv(t, home)
	writeServerJSON(t, home, `{"port":"`+freePort(t)+`"}`)

	host, _, _ := startForeground(t, StartOpts{Common: Common{Home: home}, Expose: true})
	if host != ExposeHost {
		t.Errorf("serve host = %q", host)
	}
	if m := readServerJSON(t, home); m["host"] != ExposeHost {
		t.Errorf("server.json = %v", m)
	}
	host, _, _ = startForeground(t, StartOpts{Common: Common{Home: home}})
	if host != ExposeHost {
		t.Errorf("--expose 없는 start 가 파일의 호스트를 버렸다: %q", host)
	}
}

// TC-HRB-2 (FR-HRB-4): `--isolated` 는 임시 홈의 server.json 에 고른 포트를 쓴다.
// 사용자 홈의 파일은 건드리지 않는다.
func TestStartIsolatedWritesOnlyTempHome(t *testing.T) {
	user := tempHome(t)
	isolateEnv(t, user)
	writeServerJSON(t, user, `{"port":"1234"}`)

	var served string
	t.Setenv(EnvToolID, "")
	t.Setenv(EnvRestartRunner, "")
	t.Setenv(dmenv.EnvToolHome, "")
	var out, errb bytes.Buffer
	var port string
	serve := func(home, _, p string) int { served, port = home, p; return 0 }
	if code := RunStart(StartOpts{Isolated: true, Foreground: true}, serve, &out, &errb); code != 0 {
		t.Fatalf("exit = %d: %s", code, errb.String())
	}
	t.Cleanup(func() { os.RemoveAll(served) })
	if served == user {
		t.Fatal("격리 기동이 사용자 홈으로 떴다")
	}
	if m := readServerJSON(t, served); m["port"] != port || m["host"] != dmenv.DefaultHost {
		t.Errorf("격리 홈 server.json = %v (port %s)", m, port)
	}
	if m := readServerJSON(t, user); m["port"] != "1234" || m["host"] != nil {
		t.Errorf("사용자 홈 server.json 이 바뀌었다: %v", m)
	}
}

// TC-HRB-1 (FR-HRB-1·8): 바인드 환경 변수는 `start` 의 바인드를 정하지 않고 경고 한 줄을 낸다.
func TestStartIgnoresBindEnvAndWarns(t *testing.T) {
	home := tempHome(t)
	isolateEnv(t, home)
	p := freePort(t)
	writeServerJSON(t, home, `{"port":"`+p+`"}`)
	other := freePort(t)
	t.Setenv("PORT", other)
	t.Setenv(dmenv.EnvPort, other)
	t.Setenv(dmenv.EnvHost, ExposeHost)

	host, got, stderr := startForeground(t, StartOpts{Common: Common{Home: home}})
	if got != p || host != dmenv.DefaultHost {
		t.Errorf("serve = %s:%s, want %s:%s", host, got, dmenv.DefaultHost, p)
	}
	if n := strings.Count(stderr, dmenv.EnvPort); n != 1 {
		t.Errorf("경고가 %d번 났다:\n%s", n, stderr)
	}
}

// FR-HRB-5: 백그라운드 서버에 바인드를 환경 변수로 넘기지 않고, 물려받은 것도 끊는다.
func TestServerCmdCarriesNoBindEnv(t *testing.T) {
	home := tempHome(t)
	isolateEnv(t, home)
	t.Setenv("PORT", "1111")
	t.Setenv(dmenv.EnvPort, "2222")
	t.Setenv(dmenv.EnvHost, ExposeHost)

	cmd, f, _, err := prepareServerCmd(home, filepath.Join(home, "x.log"))
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	for _, e := range cmd.Env {
		k, _, _ := strings.Cut(e, "=")
		if k == "PORT" || k == dmenv.EnvPort || k == dmenv.EnvHost {
			t.Errorf("자식 환경에 %s 가 있다", e)
		}
	}
	if !strings.Contains(strings.Join(cmd.Env, "\n"), dmenv.EnvHome+"="+home) {
		t.Error("홈을 넘기지 않았다")
	}
}

// TC-HRB-3 (FR-HRB-6): 서비스 파일에 바인드 환경 변수가 없다.
func TestServiceFilesCarryNoBindEnv(t *testing.T) {
	for _, tc := range []struct {
		name string
		body func(string, string) string
	}{
		{"plist", func(exe, home string) string {
			return launchdPlist(exe, home, serverconf.Resolve(serverconf.Inputs{Home: home}))
		}},
		{"systemd", func(exe, home string) string {
			return systemdUnit(exe, home, serverconf.Resolve(serverconf.Inputs{Home: home}))
		}},
	} {
		home := tempHome(t)
		isolateEnv(t, home)
		s := tc.body("/opt/dm", home)
		for _, bad := range []string{dmenv.EnvHost, dmenv.EnvPort, ">PORT<", "PORT="} {
			if strings.Contains(s, bad) {
				t.Errorf("%s 에 %q 가 있다:\n%s", tc.name, bad, s)
			}
		}
	}
}

// TC-HRB-3 (FR-HRB-6): 설치된 서비스 파일에 바인드 환경 변수가 남아 있으면 경고 한 줄.
func TestStaleServiceFileWarning(t *testing.T) {
	dir := tempHome(t)
	stale := filepath.Join(dir, "old.plist")
	clean := filepath.Join(dir, "new.service")
	missing := filepath.Join(dir, "none")
	if err := os.WriteFile(stale, []byte("<key>DONGMINAL_HOST</key><string>0.0.0.0</string>\n<key>PORT</key>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(clean, []byte("Environment=DONGMINAL_HOME=/x\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if w := serviceBindEnvWarning([]string{clean, missing}); w != "" {
		t.Errorf("깨끗한 파일에 경고: %q", w)
	}
	w := serviceBindEnvWarning([]string{clean, stale, missing})
	if !strings.Contains(w, stale) || !strings.Contains(w, "service install") || strings.Contains(w, "\n") {
		t.Errorf("경고 = %q", w)
	}
	linuxStale := filepath.Join(dir, "old.service")
	if err := os.WriteFile(linuxStale, []byte("Environment=PORT=58146\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if w := serviceBindEnvWarning([]string{linuxStale}); w == "" {
		t.Error("systemd 의 PORT= 를 놓쳤다")
	}
}

// FR-HRB-7: 대상 해석은 플래그 → 주소 파일 → server.json → 기본값.
func TestResolveTargetOrder(t *testing.T) {
	home := tempHome(t)
	isolateEnv(t, home)
	writeServerJSON(t, home, `{"host":"127.0.0.1","port":"9000"}`)
	if err := os.WriteFile(filepath.Join(home, serverconf.AddrFileName), []byte("0.0.0.0:9300\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tgt, err := Common{}.ResolveTarget()
	if err != nil {
		t.Fatal(err)
	}
	if tgt.Port != "9300" || tgt.Host != dmenv.DialHost("0.0.0.0") {
		t.Errorf("주소 파일이 이기지 않았다: %+v", tgt)
	}
	tgt, err = Common{Port: "7777"}.ResolveTarget()
	if err != nil {
		t.Fatal(err)
	}
	if tgt.Port != "7777" {
		t.Errorf("플래그가 주소 파일에 졌다: %+v", tgt)
	}
	if err := os.Remove(filepath.Join(home, serverconf.AddrFileName)); err != nil {
		t.Fatal(err)
	}
	tgt, _ = Common{}.ResolveTarget()
	if tgt.Port != "9000" {
		t.Errorf("주소 파일이 없으면 server.json: %+v", tgt)
	}
}
