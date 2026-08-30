package cli

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// WINDOW_COMMAND_SRS 묶음 W — `dongminal window`.
//
// 창을 여는 수단은 주입한다(Opener). 실제 브라우저를 띄우지 않고도 "무엇을,
// 몇 번 열었는가" 를 잴 수 있고, 그것이 이 명령의 전부다.

// fakeServer 는 준비된 서버 하나다. 돌려주는 port 를 그대로 --port 로 쓴다.
func fakeServer(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/ping" {
			w.WriteHeader(200)
			return
		}
		w.WriteHeader(404)
	}))
	t.Cleanup(srv.Close)
	// httptest 는 127.0.0.1:<port> 로 뜬다 — DefaultHost 와 같은 주소다.
	_, port, ok := strings.Cut(strings.TrimPrefix(srv.URL, "http://"), ":")
	if !ok {
		t.Fatalf("httptest 주소를 해석하지 못했다: %s", srv.URL)
	}
	return port
}

// V-WIN-3: 준비된 서버가 있으면 **그 주소로** 정확히 한 번 연다.
func TestRunWindow_OpensRunningServer(t *testing.T) {
	t.Setenv(EnvHost, "")
	t.Setenv(EnvPort, "")
	port := fakeServer(t)

	var got []string
	var out, errb bytes.Buffer
	code := RunWindow(WindowOpts{Common: Common{Port: port}},
		func(url string) error { got = append(got, url); return nil }, &out, &errb)

	if code != 0 {
		t.Fatalf("rc=%d stderr=%s", code, errb.String())
	}
	want := ServerURL(DefaultHost, port)
	if len(got) != 1 || got[0] != want {
		t.Fatalf("연 주소가 다르다: %v (기대 %s 한 번)", got, want)
	}
	if !strings.Contains(out.String(), want) {
		t.Fatalf("어디를 열었는지 알리지 않는다: %q", out.String())
	}
}

// V-WIN-2: 서버가 없으면 **열지 않고** 실패한다. 빈 화면을 띄우지 않는다 (D-2).
func TestRunWindow_NoServer(t *testing.T) {
	t.Setenv(EnvHost, "")
	t.Setenv(EnvPort, "")
	// 아무도 듣지 않는 포트 — 서버를 띄웠다 닫아 확실히 비운다.
	port := fakeServer(t)
	srvGone := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	_, gonePort, _ := strings.Cut(strings.TrimPrefix(srvGone.URL, "http://"), ":")
	srvGone.Close()
	if gonePort == port {
		t.Skip("포트가 겹쳤다")
	}

	opened := 0
	var out, errb bytes.Buffer
	code := RunWindow(WindowOpts{Common: Common{Port: gonePort}},
		func(string) error { opened++; return nil }, &out, &errb)

	if code == 0 {
		t.Fatal("서버가 없는데 성공했다")
	}
	if opened != 0 {
		t.Fatalf("창을 열었다 (%d회)", opened)
	}
	// FR-WIN-3: 무엇을 해야 하는지 알린다.
	if !strings.Contains(errb.String(), "dongminal start") {
		t.Fatalf("띄우는 방법을 알리지 않는다: %q", errb.String())
	}
}

// V-WIN-4: 창이 이 명령의 본체다 — 열지 못하면 실패다 (D-3).
func TestRunWindow_OpenFails(t *testing.T) {
	t.Setenv(EnvHost, "")
	t.Setenv(EnvPort, "")
	port := fakeServer(t)

	var out, errb bytes.Buffer
	code := RunWindow(WindowOpts{Common: Common{Port: port}},
		func(string) error { return errors.New("브라우저 없음") }, &out, &errb)

	if code == 0 {
		t.Fatal("창을 못 열었는데 성공으로 끝났다")
	}
	if !strings.Contains(errb.String(), "브라우저 없음") {
		t.Fatalf("원인을 전하지 않는다: %q", errb.String())
	}
}

// V-WIN-1
func TestParseWindow(t *testing.T) {
	o, err := ParseWindow([]string{"--port", "1234", "--home", "/tmp/x"})
	if err != nil {
		t.Fatalf("err=%v", err)
	}
	if o.Port != "1234" || o.Home != "/tmp/x" {
		t.Fatalf("공통 옵션을 받지 못했다: %+v", o)
	}
	if _, err := ParseWindow([]string{"--nope"}); err == nil {
		t.Fatal("모르는 옵션을 받아들였다")
	}
	if _, err := ParseWindow([]string{"--help"}); !errors.Is(err, ErrHelp) {
		t.Fatalf("--help 가 ErrHelp 가 아니다: %v", err)
	}
}

// V-WIN-7: 액션을 추가하면 자리가 넷이다 (§2.4). 사용법과 목록이 비면 발견되지 않는다.
func TestWindowHelpSurfaces(t *testing.T) {
	if u := Usage("window"); !strings.Contains(u, "dongminal window") {
		t.Fatalf("Usage(window) 가 비어 있다: %q", u)
	}
	if h := Help(); !strings.Contains(h, "window") {
		t.Fatalf("Help() 의 액션 목록에 없다")
	}
}
