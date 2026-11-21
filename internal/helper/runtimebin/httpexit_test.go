package runtimebin

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/workspace"
)

// REFACTOR3_DEDUP_GO_SRS TC-RDG-20: 종료 코드 함수 하나 — 2xx·4xx·5xx·연결 실패 × 거절
// 본문 셋(`{error}` · runs 의 `{error,detail,…}` · `{code,message}`).
func TestHTTPExitMatrix(t *testing.T) {
	bodies := map[string]string{
		"error":   `{"error":"boom"}`,
		"run":     `{"error":"node_taken","detail":"d","hint":"h"}`,
		"codemsg": `{"code":"edge_x","message":"m"}`,
	}
	rules := map[string]exitRule{
		"api":  apiRule("/api/x"),
		"run":  runRule("/api/runs"),
		"code": codeRule(),
	}
	want := map[string]string{
		"api/error":    "dmctl: boom\n",
		"api/run":      "dmctl: node_taken\n",
		"api/codemsg":  "dmctl: /api/x returned status %d: {\"code\":\"edge_x\",\"message\":\"m\"}\n",
		"run/error":    "dmctl run: boom (%d)\n",
		"run/run":      "dmctl run: node_taken (%d)\n  d\n  h\n",
		"run/codemsg":  "dmctl: /api/runs returned status %d: {\"code\":\"edge_x\",\"message\":\"m\"}\n",
		"code/error":   "dmctl: status %d: {\"error\":\"boom\"}\n",
		"code/run":     "dmctl: status %d: {\"error\":\"node_taken\",\"detail\":\"d\",\"hint\":\"h\"}\n",
		"code/codemsg": "dmctl: edge_x: m\n",
	}
	for rn, rule := range rules {
		for bn, body := range bodies {
			for _, st := range []int{200, 204, 400, 409, 500, 503} {
				var stderr bytes.Buffer
				got, code, ok := httpExit(st, []byte(body), nil, &stderr, rule)
				if st/100 == 2 {
					if code != 0 || !ok || string(got) != body || stderr.Len() != 0 {
						t.Errorf("%s/%s %d: code=%d ok=%v body=%q stderr=%q", rn, bn, st, code, ok, got, stderr.String())
					}
					continue
				}
				w := want[rn+"/"+bn]
				if strings.Contains(w, "%d") {
					w = fmt.Sprintf(w, st)
				}
				if code != 1 || ok || got != nil || stderr.String() != w {
					t.Errorf("%s/%s %d: code=%d ok=%v stderr=%q want %q", rn, bn, st, code, ok, stderr.String(), w)
				}
			}
			var stderr bytes.Buffer
			if _, code, ok := httpExit(0, nil, errors.New("refused"), &stderr, rule); code != 1 || ok || stderr.String() != "dmctl: refused\n" {
				t.Errorf("%s/%s transport: code=%d ok=%v stderr=%q", rn, bn, code, ok, stderr.String())
			}
		}
	}
}

// 종단이 연결 실패와 거절을 스스로 답하면(open-url 의 로컬 열기) 그 종료 코드가 그대로
// 나가고 ok 는 거짓이다 — 0 이어도 성공으로 읽히지 않는다.
func TestHTTPExitHandlerOwnsCode(t *testing.T) {
	rule := exitRule{
		onErr:  func(io.Writer, error) int { return 0 },
		ok:     func(s int) bool { return s == http.StatusOK },
		refuse: func(io.Writer, int, []byte) int { return 0 },
	}
	for _, c := range []struct {
		status int
		err    error
	}{{0, errors.New("x")}, {204, nil}, {500, nil}} {
		if body, code, ok := httpExit(c.status, []byte("b"), c.err, io.Discard, rule); code != 0 || ok || body != nil {
			t.Errorf("%+v: body=%q code=%d ok=%v", c, body, code, ok)
		}
	}
}

// FR-RDG-21: 거절 본문은 한 파서가 읽는다. 한 방언의 필드 모양이 틀려도 다른 방언의 읽기는
// 실패하지 않는다(종전 렌더러 셋의 판정).
func TestParseRefusalDialects(t *testing.T) {
	r, ok := parseRefusal([]byte(`{"error":"e","detail":"d","code":"c","message":"m","stale":"x"}`))
	if !ok {
		t.Fatal("parse failed")
	}
	var s string
	if !takeField(r.Error, &s) || s != "e" || !takeField(r.Code, &s) || s != "c" {
		t.Fatalf("fields: %+v", r)
	}
	var stale *bool
	if takeField(r.Stale, &stale) {
		t.Fatal("stale 는 bool 이 아니다 — 실패해야 한다")
	}
	for _, raw := range []string{"", "x", "[1]", `"s"`} {
		if _, ok := parseRefusal([]byte(raw)); ok {
			t.Errorf("%q 는 객체가 아니다", raw)
		}
	}
	if _, ok := parseRefusal([]byte("null")); !ok {
		t.Error("null 은 빈 거절이다(종전과 같다)")
	}
}

// FR-RDG-22: `/api/state` 읽기는 한 함수다.
func TestFetchStateOneReader(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/state" {
			t.Errorf("path=%s", r.URL.Path)
		}
		w.Write([]byte(`{"workspace":{"activeWindow":"w1"}}`))
	})
	defer cleanup()
	var st struct {
		Workspace *wsTree `json:"workspace"`
	}
	if code := fetchState(&st, io.Discard); code != 0 || st.Workspace == nil || st.Workspace.ActiveWindow != "w1" {
		t.Fatalf("code=%d st=%+v", code, st.Workspace)
	}
}

// FR-RDG-23: dmctl 의 워크스페이스 모양은 shared/workspace 의 것이다.
func TestWorkspaceShapeIsShared(t *testing.T) {
	var _ *workspace.WsState = (*wsTree)(nil)
	var _ *workspace.WsLayout = (*wsLayout)(nil)
	var _ *workspace.WsTab = (*wsTab)(nil)
	if workspace.ShortCode("0123456789") != "01234567" {
		t.Fatal("ShortCode")
	}
}

// TC-RDG-22: 모르는 인자의 문구는 모든 하위 명령에서 같다. 훅·상태줄처럼 Claude 가 부르는
// 명령(activity·notify·ctx-hook·agent-context·chat-mcp·statusline)은 모르는 인자를 받아
// 넘기는 것이 외부 계약이라 대상이 아니다.
func TestUnknownArgPhraseUniform(t *testing.T) {
	t.Setenv(dmenv.EnvToolID, "self-tool")
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("모르는 인자인데 서버를 불렀다: %s", r.URL.Path)
	})
	defer cleanup()
	cases := []struct {
		prefix string
		run    func(o, e io.Writer) int
	}{
		{"list-workspace", dmRun("list-workspace", "--bogus")},
		{"status", dmRun("status", "--bogus")},
		{"wait", dmRun("wait", "--bogus")},
		{"run status", dmRun("run", "status", "--bogus")},
		// 일반 워크스페이스 명령의 오류 줄에는 머리가 없다(종전과 같다).
		{"", dmRun("split-h", "--bogus")},
		{"send-input", dmRun("send-input", "--bogus")},
		{"msg", dmRun("msg", "--bogus")},
		{"read-screen", dmRun("read-screen", "--bogus")},
		{"who-am-i", dmRun("who-am-i", "--bogus")},
		{"dmctl edges", dmRun("edges", "--bogus")},
		{"dmctl edge add", dmRun("edge", "add", "--bogus")},
		{"dmctl account list", dmRun("account", "list", "--bogus")},
		{"move-tab", dmRun("move-tab", "--bogus")},
		{"list-groups", dmRun("list-groups", "--bogus")},
		{"detach", func(o, e io.Writer) int { return runDetach([]string{"--bogus"}, o, e) }},
	}
	for _, c := range cases {
		var out, errw bytes.Buffer
		code := c.run(&out, &errw)
		first, _, _ := strings.Cut(errw.String(), "\n")
		want := "unknown argument: --bogus"
		if c.prefix != "" {
			want = c.prefix + ": " + want
		}
		if code != 2 || first != want {
			t.Errorf("%s: code=%d first line=%q want %q", c.prefix, code, first, want)
		}
	}
}

func dmRun(args ...string) func(o, e io.Writer) int {
	return func(o, e io.Writer) int { return runDmctl(args, o, e) }
}

// FR-RDG-26 (DM-F3): detach 는 dmctlDelivery 로 배달을 판정한다 — 배달 수를 모르는 본문은
// "모른다" 이고 0 이다. 이전에는 "브라우저 없음" 으로 1 이었다.
func TestDetachDeliveryUnknownIsZero(t *testing.T) {
	t.Setenv(dmenv.EnvToolID, "self-tool")
	for _, body := range []string{`{}`, `null`, `not json`} {
		cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) })
		var out, errw bytes.Buffer
		if code := runDetach(nil, &out, &errw); code != 0 || errw.Len() != 0 {
			t.Errorf("%q: code=%d stderr=%q", body, code, errw.String())
		}
		cleanup()
	}
}

// FR-RDG-26 (DM-F4): who-am-i 의 toolId 는 질의 문자열로 이스케이프된다.
func TestWhoAmIEscapesToolID(t *testing.T) {
	const id = "a b&c=d"
	t.Setenv(dmenv.EnvToolID, id)
	var got string
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.Query().Get("toolId")
		w.Write([]byte(`{}`))
	})
	defer cleanup()
	runDmctl([]string{"who-am-i", "--json"}, io.Discard, io.Discard)
	if got != id {
		t.Fatalf("toolId=%q want %q", got, id)
	}
}

// FR-RDG-26 (DM-F5): account list --json 은 본문이 객체가 아니면 빈 객체에서 시작한다.
func TestAccountListJSONNullBody(t *testing.T) {
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`null`)) })
	defer cleanup()
	var out, errw bytes.Buffer
	code := runDmctlAccountStdin(strings.NewReader(""), []string{"list", "--json"}, &out, &errw)
	if want := fmt.Sprintf("{\"schemaVersion\":%d}\n", accountSchemaVersion); code != 0 || out.String() != want {
		t.Fatalf("code=%d stdout=%q stderr=%q", code, out.String(), errw.String())
	}
}
