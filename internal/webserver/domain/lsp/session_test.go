package lsp

import (
	"context"
	"encoding/json"
	"io"
	"runtime"
	"sync"
	"testing"
	"time"
)

// TC-LSP-60: 경로와 URI 의 왕복. LSP 는 `file://` URI 로만 말하므로 이 변환이
// 틀리면 서버가 우리가 말한 파일을 못 찾고, 증상은 "정의가 없다" 로 보인다.
func TestPathURIRoundTrip(t *testing.T) {
	paths := []string{"/a/b/c.go", "/a/b c/d.go", "/a/한글/e.go"}
	if runtime.GOOS == "windows" {
		paths = []string{`C:\a\b.go`, `C:\a b\c.go`}
	}
	for _, p := range paths {
		u := pathToURI(p)
		back, err := uriToPath(u)
		if err != nil {
			t.Fatalf("%q → %q → 실패: %v", p, u, err)
		}
		if back != p {
			t.Fatalf("왕복이 경로를 바꿨다: %q → %q → %q", p, u, back)
		}
	}
}

// TC-LSP-61: LSP 는 줄·열을 **0 부터** 세고 우리 종단과 편집기는 1 부터 센다.
// 한쪽만 바꾸면 정의가 한 줄 위·한 칸 왼쪽으로 뛴다 — 맞는 것처럼 보여서 오래
// 남는 종류의 결함이다.
func TestPositionBase(t *testing.T) {
	// 우리 → LSP
	l, c := toLSPPos(1, 1)
	if l != 0 || c != 0 {
		t.Fatalf("1,1 이 LSP 의 0,0 이 아니다: %d,%d", l, c)
	}
	// LSP → 우리
	l2, c2 := fromLSPPos(0, 0)
	if l2 != 1 || c2 != 1 {
		t.Fatalf("LSP 0,0 이 1,1 이 아니다: %d,%d", l2, c2)
	}
	// 0 이하가 들어오면 1 로 여민다 — 음수 좌표로 서버에 묻지 않는다.
	if l, c := toLSPPos(0, -5); l != 0 || c != 0 {
		t.Fatalf("여미기가 되지 않았다: %d,%d", l, c)
	}
}

// 가짜 언어 서버를 프로세스 없이 세운다. `Starter` 를 주입받는 이유가 이것이다 —
// 검사가 gopls 설치 여부에 매이면 어느 기계에서는 돌지 않는다.
func fakeStarter(t *testing.T, handle func(*fakeServer, map[string]any)) (Starter, chan struct{}) {
	t.Helper()
	stopped := make(chan struct{})
	// **한 번만 닫는다.** 이 Starter 는 여러 세션에 쓰이므로(관리자 검사가 그렇게
	// 쓴다) 세션마다 닫으면 두 번째에서 close of closed channel 로 죽는다.
	var once sync.Once
	closeStopped := func() { once.Do(func() { close(stopped) }) }
	return func(_ context.Context, _ string, _ []string, _ string) (io.ReadWriteCloser, func(), error) {
		cr, sw := io.Pipe()
		sr, cw := io.Pipe()
		srv := &fakeServer{fromClient: newBufReader(sr), toClient: sw}
		go func() {
			for {
				b, err := readFrame(srv.fromClient)
				if err != nil {
					return
				}
				var m map[string]any
				if json.Unmarshal(b, &m) != nil {
					continue
				}
				handle(srv, m)
			}
		}()
		return rwc{Reader: cr, Writer: cw, closeFn: func() error {
			cw.Close()
			cr.Close()
			return nil
		}}, closeStopped, nil
	}, stopped
}

// TC-LSP-62 (FR-LSP-15 / D-3): 순서가 규약이다 —
// `initialize` → `initialized` → `didOpen` → `definition`.
//
// 핸드셰이크 전에 온 요청은 **기다린다** (버리지 않는다). 파일을 열자마자 누른
// F12 가 죽으면 사용자는 기능이 없는 줄로 읽는다.
func TestSession_HandshakeThenSyncThenAsk(t *testing.T) {
	var order []string
	start, _ := fakeStarter(t, func(s *fakeServer, m map[string]any) {
		method, _ := m["method"].(string)
		order = append(order, method)
		switch method {
		case "initialize":
			s.replyRaw(m["id"], map[string]any{"capabilities": map[string]any{}})
		case "textDocument/definition":
			s.replyRaw(m["id"], []map[string]any{{
				"uri": pathToURI("/root/other.go"),
				"range": map[string]any{
					"start": map[string]any{"line": 41, "character": 7},
					"end":   map[string]any{"line": 41, "character": 12},
				},
			}})
		}
	})

	sess := newSession("/root", mustDesc(t, ".go"), "/fake/gopls", start, nil)
	defer sess.Close()

	locs, err := sess.Definition(context.Background(), "/root/a.go", "package a\n", 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(locs) != 1 {
		t.Fatalf("정의가 하나가 아니다: %+v", locs)
	}
	// LSP 의 41,7 은 우리의 42,8 이다.
	if locs[0].Path != "/root/other.go" || locs[0].Line != 42 || locs[0].Col != 8 {
		t.Fatalf("자리가 어긋났다: %+v", locs[0])
	}

	want := []string{"initialize", "initialized", "textDocument/didOpen", "textDocument/definition"}
	if len(order) < len(want) {
		t.Fatalf("주고받은 순서가 짧다: %v", order)
	}
	for i, w := range want {
		if order[i] != w {
			t.Fatalf("순서가 규약과 다르다:\n got=%v\nwant=%v", order, want)
		}
	}
}

// TC-LSP-63 (D-3): 같은 파일을 다시 물으면 `didOpen` 이 아니라 `didChange` 다.
// 두 번 `didOpen` 하면 서버가 그 문서를 이미 열려 있다고 거절하거나 상태가 어긋난다.
func TestSession_SecondAskSendsDidChange(t *testing.T) {
	var methods []string
	start, _ := fakeStarter(t, func(s *fakeServer, m map[string]any) {
		method, _ := m["method"].(string)
		methods = append(methods, method)
		switch method {
		case "initialize":
			s.replyRaw(m["id"], map[string]any{})
		case "textDocument/definition":
			s.replyRaw(m["id"], []any{})
		}
	})
	sess := newSession("/root", mustDesc(t, ".go"), "/fake/gopls", start, nil)
	defer sess.Close()

	if _, err := sess.Definition(context.Background(), "/root/a.go", "v1\n", 1, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := sess.Definition(context.Background(), "/root/a.go", "v2\n", 1, 1); err != nil {
		t.Fatal(err)
	}
	opens, changes := 0, 0
	for _, m := range methods {
		switch m {
		case "textDocument/didOpen":
			opens++
		case "textDocument/didChange":
			changes++
		}
	}
	if opens != 1 || changes != 1 {
		t.Fatalf("didOpen %d 번, didChange %d 번 — 각각 한 번이어야 한다 (%v)", opens, changes, methods)
	}
}

// TC-LSP-64 (FR-LSP-15): 핸드셰이크가 실패하면 요청이 **오류로** 끝난다 — 영원히
// 기다리지 않는다.
func TestSession_HandshakeFailureFailsCalls(t *testing.T) {
	start, _ := fakeStarter(t, func(s *fakeServer, m map[string]any) {
		if m["method"] == "initialize" {
			s.replyErrorRaw(m["id"], -32603, "internal error")
		}
	})
	sess := newSession("/root", mustDesc(t, ".go"), "/fake/gopls", start, nil)
	defer sess.Close()

	done := make(chan error, 1)
	go func() {
		_, err := sess.Definition(context.Background(), "/root/a.go", "x\n", 1, 1)
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("핸드셰이크가 실패했는데 요청이 성공했다")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("핸드셰이크 실패에 요청이 매달렸다")
	}
}

// TC-LSP-65 (FR-LSP-22): 참조는 선언을 포함할지 요청이 정한다.
func TestSession_ReferencesPassesIncludeDeclaration(t *testing.T) {
	var ctxParam bool
	var seen bool
	start, _ := fakeStarter(t, func(s *fakeServer, m map[string]any) {
		switch m["method"] {
		case "initialize":
			s.replyRaw(m["id"], map[string]any{})
		case "textDocument/references":
			seen = true
			if p, ok := m["params"].(map[string]any); ok {
				if c, ok := p["context"].(map[string]any); ok {
					ctxParam, _ = c["includeDeclaration"].(bool)
				}
			}
			s.replyRaw(m["id"], []any{})
		}
	})
	sess := newSession("/root", mustDesc(t, ".go"), "/fake/gopls", start, nil)
	defer sess.Close()

	if _, err := sess.References(context.Background(), "/root/a.go", "x\n", 1, 1, true); err != nil {
		t.Fatal(err)
	}
	if !seen {
		t.Fatal("references 요청이 가지 않았다")
	}
	if !ctxParam {
		t.Fatal("includeDeclaration 이 전달되지 않았다")
	}
}

// TC-LSP-66 (FR-LSP-18·20): Close 는 프로세스를 정지시킨다. 언어 서버는 큰
// 저장소에서 수백 MB 를 쓴다.
func TestSession_CloseStopsProcess(t *testing.T) {
	start, stopped := fakeStarter(t, func(s *fakeServer, m map[string]any) {
		switch m["method"] {
		case "initialize":
			s.replyRaw(m["id"], map[string]any{})
		case "textDocument/definition":
			// **답해야 한다.** 답하지 않으면 아래 Definition 이 영원히 기다려
			// Close 에 닿지 못한다 (ctx 가 Background 다) — 그것은 이 검사가
			// 재려는 것이 아니다.
			s.replyRaw(m["id"], []any{})
		}
	})
	sess := newSession("/root", mustDesc(t, ".go"), "/fake/gopls", start, nil)
	// 핸드셰이크가 실제로 돌게 한 뒤 닫는다.
	if _, err := sess.Definition(context.Background(), "/root/a.go", "x\n", 1, 1); err != nil {
		t.Fatal(err)
	}
	sess.Close()

	select {
	case <-stopped:
	case <-time.After(3 * time.Second):
		t.Fatal("Close 가 프로세스를 정지시키지 않았다")
	}
}

func mustDesc(t *testing.T, ext string) Descriptor {
	t.Helper()
	d, ok := DescriptorForExt(ext)
	if !ok {
		t.Fatalf("%s 서술자가 없다", ext)
	}
	return d
}

// TC-LSP-67 (FR-LSP-29·30): 호버는 정의 이동과 **같은 세션·같은 동기화**를 쓴다.
// 두 벌로 두면 한쪽만 낡는다.
func TestSession_Hover(t *testing.T) {
	var methods []string
	start, _ := fakeStarter(t, func(s *fakeServer, m map[string]any) {
		method, _ := m["method"].(string)
		methods = append(methods, method)
		switch method {
		case "initialize":
			s.replyRaw(m["id"], map[string]any{})
		case "textDocument/hover":
			s.replyRaw(m["id"], map[string]any{
				"contents": map[string]any{"kind": "markdown", "value": "func helper()"},
			})
		}
	})
	sess := newSession("/root", mustDesc(t, ".go"), "/fake/gopls", start, nil)
	defer sess.Close()

	got, err := sess.Hover(context.Background(), "/root/a.go", "package a\n", 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if got != "func helper()" {
		t.Fatalf("호버 내용이 다르다: %q", got)
	}
	// didOpen 이 호버 앞에 있어야 한다 — 그것이 D-3 의 동기화다.
	var openAt, hoverAt = -1, -1
	for i, m := range methods {
		if m == "textDocument/didOpen" {
			openAt = i
		}
		if m == "textDocument/hover" {
			hoverAt = i
		}
	}
	if openAt < 0 || hoverAt < 0 || openAt > hoverAt {
		t.Fatalf("동기화가 호버 앞에 없다: %v", methods)
	}
}

// TC-LSP-68 (FR-LSP-29): LSP 의 세 가지 contents 모양을 모두 받는다. 서버마다
// 다르므로 하나만 받으면 어떤 서버에서는 호버가 늘 비어 보인다.
func TestSession_HoverContentShapes(t *testing.T) {
	cases := []struct {
		name string
		res  any
		want string
	}{
		{"MarkupContent", map[string]any{
			"contents": map[string]any{"kind": "markdown", "value": "A"}}, "A"},
		{"MarkedString(문자열)", map[string]any{"contents": "B"}, "B"},
		{"MarkedString(객체)", map[string]any{
			"contents": map[string]any{"language": "go", "value": "C"}}, "C"},
		{"배열", map[string]any{
			"contents": []any{"D", map[string]any{"value": "E"}}}, "D\n\nE"},
		{"빈 것", map[string]any{}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := c.res
			start, _ := fakeStarter(t, func(s *fakeServer, m map[string]any) {
				switch m["method"] {
				case "initialize":
					s.replyRaw(m["id"], map[string]any{})
				case "textDocument/hover":
					s.replyRaw(m["id"], res)
				}
			})
			sess := newSession("/root", mustDesc(t, ".go"), "/fake/gopls", start, nil)
			defer sess.Close()
			got, err := sess.Hover(context.Background(), "/root/a.go", "x\n", 1, 1)
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("%s: %q (기대 %q)", c.name, got, c.want)
			}
		})
	}
}

// TC-LSP-69 (FR-LSP-32·33): 진단은 **요청 없이** 온다. 서버가 밀어 준 알림이
// 파싱되어 콜백으로 오고, 좌표는 우리 셈법(1 부터)이며 uri 는 경로로 풀린다.
func TestSession_PublishDiagnostics(t *testing.T) {
	got := make(chan Diagnostics, 4)
	start, _ := fakeStarter(t, func(s *fakeServer, m map[string]any) {
		if m["method"] == "initialize" {
			s.replyRaw(m["id"], map[string]any{})
			// 핸드셰이크 뒤에 밀어 준다 — 실제 서버가 그렇게 한다.
			s.notifyRaw("textDocument/publishDiagnostics", map[string]any{
				"uri": pathToURI("/root/a.go"),
				"diagnostics": []map[string]any{
					{
						"range": map[string]any{
							"start": map[string]any{"line": 4, "character": 1},
							"end":   map[string]any{"line": 4, "character": 9},
						},
						"severity": 1,
						"message":  "undefined: helper",
						"source":   "compiler",
					},
					{
						"range": map[string]any{
							"start": map[string]any{"line": 9, "character": 0},
							"end":   map[string]any{"line": 9, "character": 3},
						},
						"severity": 2,
						"message":  "unused variable",
					},
				},
			})
		}
	})
	sess := newSession("/root", mustDesc(t, ".go"), "/fake/gopls", start,
		func(d Diagnostics) { got <- d })
	defer sess.Close()

	// 핸드셰이크를 돌린다 — 그것이 알림의 계기다.
	if err := sess.waitReady(context.Background()); err != nil {
		t.Fatal(err)
	}

	select {
	case d := <-got:
		if d.Path != "/root/a.go" {
			t.Fatalf("경로가 풀리지 않았다: %q", d.Path)
		}
		if len(d.Items) != 2 {
			t.Fatalf("진단이 둘이 아니다: %+v", d.Items)
		}
		// LSP 의 4,1 은 우리의 5,2 다.
		if d.Items[0].Line != 5 || d.Items[0].Col != 2 {
			t.Fatalf("좌표가 어긋났다: %+v", d.Items[0])
		}
		if d.Items[0].EndLine != 5 || d.Items[0].EndCol != 10 {
			t.Fatalf("끝 좌표가 어긋났다: %+v", d.Items[0])
		}
		if d.Items[0].Severity != 1 || d.Items[0].Message != "undefined: helper" {
			t.Fatalf("내용이 다르다: %+v", d.Items[0])
		}
		if d.Items[1].Severity != 2 {
			t.Fatalf("두 번째의 심각도가 다르다: %+v", d.Items[1])
		}
	case <-time.After(3 * time.Second):
		t.Fatal("진단이 오지 않았다")
	}
}

// TC-LSP-69b (FR-LSP-33): 진단이 **비어서** 오는 것도 알림이다 — 그것이 "이 파일은
// 이제 깨끗하다" 는 뜻이며, 그때 앞선 밑줄을 걷어야 한다.
func TestSession_EmptyDiagnosticsStillNotifies(t *testing.T) {
	got := make(chan Diagnostics, 2)
	start, _ := fakeStarter(t, func(s *fakeServer, m map[string]any) {
		if m["method"] == "initialize" {
			s.replyRaw(m["id"], map[string]any{})
			s.notifyRaw("textDocument/publishDiagnostics", map[string]any{
				"uri":         pathToURI("/root/a.go"),
				"diagnostics": []any{},
			})
		}
	})
	sess := newSession("/root", mustDesc(t, ".go"), "/fake/gopls", start,
		func(d Diagnostics) { got <- d })
	defer sess.Close()
	sess.waitReady(context.Background())

	select {
	case d := <-got:
		if d.Path != "/root/a.go" {
			t.Fatalf("경로가 다르다: %q", d.Path)
		}
		if d.Items == nil {
			t.Fatal("Items 가 nil 이다 — 빈 배열이어야 화면이 '걷어라' 로 읽는다")
		}
		if len(d.Items) != 0 {
			t.Fatalf("빈 진단이 아니다: %+v", d.Items)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("빈 진단이 오지 않았다 — 그것도 알림이다")
	}
}
