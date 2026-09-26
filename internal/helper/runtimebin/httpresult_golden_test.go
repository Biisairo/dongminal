package runtimebin

import (
	"bytes"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// FR-OPT-9-2 (SHR-16): HTTP 결과 → 종료 코드 변환을 모은 뒤에도 서버 거부의 stderr
// 바이트와 종료 코드가 그대로인지 골든으로 고정한다. 골든은 통일 전 코드가 만든 것이다.

var updateHTTPGolden = flag.Bool("update-http-golden", false, "rewrite testdata/httpresult.golden")

func TestHTTPResultGolden(t *testing.T) {
	t.Setenv(dmenv.EnvToolID, "self-tool")
	cmds := [][]string{
		{"who-am-i"}, {"read-output", "--at", "t"}, {"send-input", "--at", "t", "hi"}, {"msg", "--to", "t", "hi"},
		{"status", "--at", "t"}, {"list-workspace"}, {"send", "focus"}, {"send", "focus", `{"location":"1"}`},
		{"focus", "1"}, {"run", "status", "--run", "r1"},
	}
	bodies := []struct {
		status int
		body   string
	}{
		{500, `{"error":"boom"}`}, {502, "raw body"}, {400, ""}, {409, `{"error":"conflict","detail":"d","code":"x"}`},
		{200, `{"delivered":0}`}, {200, `{"delivered":1,"timedOut":true}`},
	}
	var b strings.Builder
	for _, bd := range bodies {
		cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(bd.status)
			w.Write([]byte(bd.body))
		})
		for _, c := range cmds {
			var out, errw bytes.Buffer
			code := runDmctl(c, &out, &errw)
			fmt.Fprintf(&b, "%d %q %q\n  code=%d\n  stdout=%q\n  stderr=%q\n", bd.status, bd.body, c, code, out.String(), errw.String())
		}
		cleanup()
	}
	path := filepath.Join("testdata", "httpresult.golden")
	if *updateHTTPGolden {
		if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := b.String(); got != string(want) {
		gl, wl := strings.Split(got, "\n"), strings.Split(string(want), "\n")
		for i := 0; i < len(gl) && i < len(wl); i++ {
			if gl[i] != wl[i] {
				t.Fatalf("golden mismatch at line %d:\n got %s\nwant %s", i+1, gl[i], wl[i])
			}
		}
		t.Fatalf("golden length mismatch: got %d lines want %d", len(gl), len(wl))
	}
}
