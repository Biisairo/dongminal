package cli

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/serverconf"
)

// HOT_REBIND_SRS 묶음 U — `dongminal config set|get` (FR-HRB-41·42·43, TC-HRB-12).

func TestParseConfigSetGet(t *testing.T) {
	for _, ok := range [][]string{
		{"set", "port", "9100"}, {"set", "expose", "on"}, {"set", "expose", "off"}, {"get"},
	} {
		if _, err := ParseConfig(ok); err != nil {
			t.Errorf("%v: %v", ok, err)
		}
	}
	for _, bad := range [][]string{
		{"set"}, {"set", "port"}, {"set", "port", "80"}, {"set", "port", "abc"},
		{"set", "expose", "maybe"}, {"set", "host", "1.2.3.4"}, {"get", "port"}, {"show", "x"},
	} {
		if _, err := ParseConfig(bad); err == nil {
			t.Errorf("%v 가 통과했다", bad)
		}
	}
}

func runConfig(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	o, err := ParseConfig(args)
	if err != nil {
		t.Fatal(err)
	}
	var out, errw bytes.Buffer
	code := RunConfig(o, &out, &errw)
	return code, out.String(), errw.String()
}

// TC-HRB-12: 서버가 돌고 있지 않으면 server.json 만 고친다.
func TestConfigSetWithoutServer(t *testing.T) {
	home := tempHome(t)
	isolateEnv(t, home)
	writeServerJSON(t, home, `{"logLevel":"debug"}`)

	if code, out, errw := runConfig(t, "set", "port", "9100"); code != 0 || !strings.Contains(out, "server.json") {
		t.Fatalf("exit %d out=%s err=%s", code, out, errw)
	}
	if m := readServerJSON(t, home); m["port"] != "9100" || m["logLevel"] != "debug" {
		t.Errorf("server.json = %v", m)
	}
	runConfig(t, "set", "expose", "on")
	if m := readServerJSON(t, home); m["host"] != ExposeHost {
		t.Errorf("expose on: %v", m)
	}
	runConfig(t, "set", "expose", "off")
	if m := readServerJSON(t, home); m["host"] != DefaultHost {
		t.Errorf("expose off: %v", m)
	}
}

// fakeBindServer 는 돌고 있는 서버를 흉내 낸다. 주소 파일이 그것을 가리킨다.
func fakeBindServer(t *testing.T, home string, status int, reply string) *[]string {
	t.Helper()
	var bodies []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/server/bind" && r.Method == http.MethodPost {
			raw, _ := io.ReadAll(r.Body)
			bodies = append(bodies, string(raw))
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write([]byte(reply))
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ts.Close)
	u, _ := url.Parse(ts.URL)
	if err := serverconf.WriteAddr(home, u.Host); err != nil {
		t.Fatal(err)
	}
	return &bodies
}

// TC-HRB-12: 서버가 돌고 있으면 리바인드 API 를 부르고 server.json 은 건드리지 않는다.
func TestConfigSetWithServerCallsAPI(t *testing.T) {
	home := tempHome(t)
	isolateEnv(t, home)
	bodies := fakeBindServer(t, home, http.StatusOK,
		`{"host":"0.0.0.0","port":"9100","expose":true,"url":"http://127.0.0.1:9100","warning":"인증이 없습니다"}`)

	code, out, errw := runConfig(t, "set", "port", "9100")
	if code != 0 {
		t.Fatalf("exit %d err=%s", code, errw)
	}
	if len(*bodies) != 1 {
		t.Fatalf("API 호출 = %v", *bodies)
	}
	var got map[string]any
	if err := json.Unmarshal([]byte((*bodies)[0]), &got); err != nil || got["port"] != float64(9100) {
		t.Errorf("본문 = %s", (*bodies)[0])
	}
	if !strings.Contains(out, "9100") || !strings.Contains(out+errw, "인증이 없습니다") {
		t.Errorf("출력 = %s / %s", out, errw)
	}
	runConfig(t, "set", "expose", "off")
	if err := json.Unmarshal([]byte((*bodies)[1]), &got); err != nil || got["expose"] != false {
		t.Errorf("본문 = %s", (*bodies)[1])
	}
	if m := readServerJSONIfAny(t, home); len(m) != 0 {
		t.Errorf("서버가 있는데 server.json 을 고쳤다: %v", m)
	}
}

// FR-HRB-43: API 의 오류 코드를 사람 말로 보인다.
func TestConfigSetShowsHumanError(t *testing.T) {
	home := tempHome(t)
	isolateEnv(t, home)
	fakeBindServer(t, home, http.StatusConflict, `{"code":"bind_port_in_use","message":"rebind failed"}`)
	code, _, errw := runConfig(t, "set", "port", "9100")
	if code != 1 || !strings.Contains(errw, "다른 프로세스") {
		t.Errorf("exit %d err=%s", code, errw)
	}
}

// FR-HRB-42: get 은 지금 바인드(주소 파일)와 server.json 의 값을 함께 보인다.
func TestConfigGet(t *testing.T) {
	home := tempHome(t)
	isolateEnv(t, home)
	writeServerJSON(t, home, `{"port":"9200"}`)
	_, out, _ := runConfig(t, "get")
	if !strings.Contains(out, "돌고 있지 않") || !strings.Contains(out, "9200") || !strings.Contains(out, "file") {
		t.Errorf("서버 없음 출력:\n%s", out)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() { _ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {})) }()
	if err := serverconf.WriteAddr(home, ln.Addr().String()); err != nil {
		t.Fatal(err)
	}
	_, out, _ = runConfig(t, "get")
	if !strings.Contains(out, ln.Addr().String()) || !strings.Contains(out, "9200") {
		t.Errorf("서버 있음 출력:\n%s", out)
	}
}

func readServerJSONIfAny(t *testing.T, home string) map[string]any {
	t.Helper()
	m := map[string]any{}
	if raw, err := readFileIfAny(home); err == nil && len(raw) > 0 {
		_ = json.Unmarshal(raw, &m)
	}
	return m
}

func readFileIfAny(home string) ([]byte, error) {
	return os.ReadFile(filepath.Join(home, serverconf.FileName))
}
