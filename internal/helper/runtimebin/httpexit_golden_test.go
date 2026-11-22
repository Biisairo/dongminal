package runtimebin

import (
	"bytes"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// REFACTOR3_DEDUP_GO_SRS FR-RDG-20·21 (INV-2): 응답 → 종료 코드 변환 아홉 자리를 한 함수로
// 모은 뒤에도 종단마다 stdout·stderr 바이트와 종료 코드가 그대로인지 골든으로 고정한다.
// 골든은 모으기 전 코드가 만든 것이다. httpresult.golden 이 덮지 않는 종단(detach·edit·
// open-url·edges·edge·account·move-tab·notify·list-groups·read-screen)과 연결 실패·
// 방언별 필드 모양이 틀린 본문을 더한다.

var updateHTTPExitGolden = flag.Bool("update-httpexit-golden", false, "rewrite testdata/httpexit.golden")

type httpExitCmd struct {
	name string
	run  func(stdout, stderr *bytes.Buffer) int
	// skip 은 §5 가 바꾼 조합이다 — 골든이 아니라 따로 시험한다.
	skip func(status int, body string) bool
}

func httpExitGoldenCmds(t *testing.T) []httpExitCmd {
	file := filepath.Join(t.TempDir(), "f.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	opener := func(w *bytes.Buffer) func(string) error {
		return func(u string) error {
			fmt.Fprintf(w, "OPEN %s\n", u)
			return nil
		}
	}
	dm := func(args ...string) func(o, e *bytes.Buffer) int {
		return func(o, e *bytes.Buffer) int { return runDmctl(args, o, e) }
	}
	// DM-F3: detach 가 배달 수를 모르는 본문을 1 로 읽던 것은 §5 의 변경이다.
	detachSkip := func(status int, body string) bool {
		return status/100 == 2 && !strings.Contains(body, `"delivered"`)
	}
	return []httpExitCmd{
		{name: "detach", run: func(o, e *bytes.Buffer) int { return runDetach(nil, o, e) }, skip: detachSkip},
		{name: "detach --restore", run: func(o, e *bytes.Buffer) int { return runDetach([]string{"--restore", "x"}, o, e) }, skip: detachSkip},
		{name: "detach --list", run: func(o, e *bytes.Buffer) int { return runDetach([]string{"--list"}, o, e) }},
		{name: "detach --run", run: func(o, e *bytes.Buffer) int { return runDetach([]string{"--run", "ls"}, o, e) }},
		{name: "edit", run: func(o, e *bytes.Buffer) int { return runEdit([]string{file}, o, e) }},
		{name: "open-url", run: func(o, e *bytes.Buffer) int { return openURLWith([]string{"https://x"}, o, e, opener(o)) }},
		{name: "edges", run: dm("edges")},
		{name: "edge add", run: dm("edge", "add", "c")},
		// DM-F5: 본문이 null 이면 옛 코드는 panic 한다 — 따로 시험한다.
		{name: "account list --json", run: dm("account", "list", "--json"), skip: func(s int, b string) bool { return s/100 == 2 && b == "null" }},
		{name: "account list", run: dm("account", "list")},
		{name: "move-tab", run: dm("move-tab", "--at", "11111111-1111-4111-8111-111111111111", "--next")},
		{name: "notify", run: dm("notify", "done")},
		{name: "list-groups", run: dm("list-groups")},
		{name: "read-screen", run: dm("read-screen", "--at", "t")},
		{name: "wait", run: dm("wait", "--at", "t", "--timeout-ms", "10")},
		{name: "run tree", run: dm("run", "tree", "--ref", "o/r#32")},
		{name: "run close", run: dm("run", "close", "--run", "r1")},
	}
}

func TestHTTPExitGolden(t *testing.T) {
	t.Setenv(dmenv.EnvToolID, "self-tool")
	cmds := httpExitGoldenCmds(t)
	bodies := []struct {
		status int
		body   string
	}{
		{200, `{}`}, {200, `null`}, {200, `{"delivered":0}`}, {200, `{"delivered":1}`}, {200, `{"where":"local"}`},
		{200, `{"where":"viewer","delivered":1}`}, {200, `{"error":"bad move","delivered":1}`}, {204, ``}, {302, `moved`},
		{400, `{"error":"bad"}`}, {400, "bad url\n"}, {409, `{"error":"conflict","detail":"d","code":"x"}`},
		{409, `{"error":"node_taken","memberId":"m","state":"s","hint":"h","runId":"r","stale":true,"unreported":[{"role":"a","state":"b","memberId":"c"}]}`},
		{422, "{\"code\":\"edge_x\",\"message\":\"m\\u0007\"}"}, {500, "raw body"}, {500, `{"error":5}`},
		{503, `{"error":"e","stale":"x"}`}, {502, `{"code":7,"message":"m"}`}, {500, `[1]`},
	}
	var b strings.Builder
	for _, bd := range bodies {
		cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(bd.status)
			w.Write([]byte(bd.body))
		})
		for _, c := range cmds {
			if c.skip != nil && c.skip(bd.status, bd.body) {
				continue
			}
			var out, errw bytes.Buffer
			code := c.run(&out, &errw)
			fmt.Fprintf(&b, "%d %q %s\n  code=%d\n  stdout=%q\n  stderr=%q\n", bd.status, bd.body, c.name, code, out.String(), errw.String())
		}
		cleanup()
	}
	// 연결 실패: 닫힌 포트. 포트 번호는 실행마다 다르므로 지운다.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := fmt.Sprint(ln.Addr().(*net.TCPAddr).Port)
	ln.Close()
	pointAt(t, "127.0.0.1", port)
	for _, c := range cmds {
		var out, errw bytes.Buffer
		code := c.run(&out, &errw)
		fmt.Fprintf(&b, "refused %s\n  code=%d\n  stdout=%q\n  stderr=%q\n", c.name, code,
			strings.ReplaceAll(out.String(), port, "PORT"), refusedText(strings.ReplaceAll(errw.String(), port, "PORT")))
	}

	path := filepath.Join("testdata", "httpexit.golden")
	if *updateHTTPExitGolden {
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

// refusedText 는 OS 마다 다른 연결 거부 문구를 골든의 문구(Unix)로 맞춘다. 문구는 Go 의
// net 오류가 OS 에서 받아 그대로 싣는 것이다 — 명령이 내는 글이 아니다.
func refusedText(s string) string {
	return strings.ReplaceAll(s,
		"connectex: No connection could be made because the target machine actively refused it.",
		"connect: connection refused")
}
