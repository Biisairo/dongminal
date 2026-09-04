package lsp

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/platform"
)

// HandshakeTimeout 은 `initialize` 의 상한이다.
//
// gopls 는 큰 저장소에서 첫 응답까지 여러 초를 쓴다 — 모듈 그래프를 읽기 때문이다.
// 그래도 상한이 있어야 한다: 없으면 답하지 않는 서버 하나에 그 루트의 모든 요청이
// 영원히 매달린다.
const HandshakeTimeout = 60 * time.Second

// Location 은 정의·참조가 가리키는 자리다.
//
// **줄·열은 1 부터다.** LSP 는 0 부터 세지만 우리 종단과 편집기는 1 부터 세므로,
// 경계를 여기 한 곳에 둔다 (toLSPPos·fromLSPPos). 한쪽만 바꾸면 정의가 한 줄 위·
// 한 칸 왼쪽으로 뛰는데, 그것이 맞는 것처럼 보여서 오래 남는다.
type Location struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Col  int    `json:"col"`
}

// Diagnostic 은 에러·경고 하나다 (FR-LSP-33).
//
// 좌표는 **1 부터**다 — Location 과 같은 규약이며, 경계는 fromLSPPos 한 곳이다.
type Diagnostic struct {
	Line    int `json:"line"`
	Col     int `json:"col"`
	EndLine int `json:"endLine"`
	EndCol  int `json:"endCol"`
	// Severity 는 LSP 의 것을 그대로 쓴다: 1=에러 2=경고 3=정보 4=힌트.
	// 우리 말로 바꾸지 않는 이유는 화면이 Monaco 의 MarkerSeverity 로 옮기기
	// 때문이다 — 중간에 우리 어휘를 하나 더 두면 두 번 옮겨야 한다.
	Severity int    `json:"severity"`
	Message  string `json:"message"`
	Source   string `json:"source,omitempty"`
}

// Diagnostics 는 한 파일의 진단 묶음이다.
//
// **비어서 오는 것도 알림이다** — 그것이 "이 파일은 이제 깨끗하다" 는 뜻이며, 그때
// 앞선 밑줄을 걷어야 한다. 그래서 Items 는 nil 이 아니라 빈 배열로 낸다.
type Diagnostics struct {
	Path  string       `json:"path"`
	Items []Diagnostic `json:"items"`
}

// DiagFunc 은 진단이 왔을 때 부를 함수다.
//
// 도메인 계층은 이것이 SSE 인지 모른다 — 배선이 그것을 정한다 (D-4).
type DiagFunc func(Diagnostics)

// Starter 는 언어 서버 프로세스를 세운다.
//
// 주입받는 이유는 검사다 — 실제 프로세스에 매이면 gopls 가 없는 기계에서는 세션
// 계층을 하나도 잴 수 없다.
type Starter func(ctx context.Context, exe string, args []string, dir string) (io.ReadWriteCloser, func(), error)

// StartProcess 는 실제 프로세스를 stdio 로 세운다.
func StartProcess(ctx context.Context, exe string, args []string, dir string) (io.ReadWriteCloser, func(), error) {
	cmd := exec.Command(exe, args...)
	cmd.Dir = dir
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	stop := func() {
		// stdin 을 닫는 것이 LSP 서버에게 "끝났다" 를 말하는 관용이다. 그래도
		// 남으면 죽인다 — 안 죽이면 idle 정리가 아무것도 정리하지 않는다.
		_ = in.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	}
	return rwPipes{r: out, w: in}, stop, nil
}

type rwPipes struct {
	r io.ReadCloser
	w io.WriteCloser
}

func (p rwPipes) Read(b []byte) (int, error)  { return p.r.Read(b) }
func (p rwPipes) Write(b []byte) (int, error) { return p.w.Write(b) }
func (p rwPipes) Close() error {
	_ = p.w.Close()
	return p.r.Close()
}

// Session 은 (루트, 서술자) 한 쌍의 언어 서버다 (FR-LSP-13).
//
// 같은 루트의 `.go` 파일 여럿이 한 `gopls` 를 공유하고, `.ts` 와 `.js` 도 한
// `typescript-language-server` 를 공유한다.
type Session struct {
	root string
	desc Descriptor
	exe  string

	c    *conn
	stop func()

	// ready 는 핸드셰이크가 끝났을 때 닫힌다. **요청은 이것을 기다린다**
	// (FR-LSP-15) — 파일을 열자마자 누른 F12 가 죽으면 사용자는 기능이 없는
	// 줄로 읽는다.
	ready   chan struct{}
	initErr error
	once    sync.Once

	mu sync.Mutex
	// open 은 서버가 알고 있는 문서의 판이다 (uri → version).
	//
	// 두 번 `didOpen` 하면 서버가 이미 열려 있다고 거절하거나 상태가 어긋난다 —
	// 그래서 두 번째부터는 `didChange` 다 (D-3).
	open    map[string]int
	lastUse time.Time
}

// newSession 은 세션을 만든다. 프로세스는 여기서 서고, 핸드셰이크는 **첫 요청이**
// 기다린다 — 기동만 해 두고 아무도 묻지 않는 경우에 그 비용을 미리 내지 않는다.
func newSession(root string, d Descriptor, exe string, start Starter,
	onDiag DiagFunc) *Session {
	s := &Session{
		root:    root,
		desc:    d,
		exe:     exe,
		ready:   make(chan struct{}),
		open:    map[string]int{},
		lastUse: time.Now(),
	}
	rwc, stop, err := start(context.Background(), exe, d.Args, root)
	if err != nil {
		s.initErr = fmt.Errorf("lsp: %s 를 띄우지 못했습니다: %w", d.ID, err)
		close(s.ready)
		return s
	}
	s.stop = stop
	s.c = newConn(rwc, func(method string, params json.RawMessage) {
		// FR-LSP-32: 진단은 **요청 없이** 온다. 이 통로가 그 유일한 입구다.
		if onDiag == nil || method != "textDocument/publishDiagnostics" {
			return
		}
		if d, ok := parseDiagnostics(params); ok {
			onDiag(d)
		}
	})
	return s
}

// Root·ID 는 관리자가 세션을 가리키는 데 쓴다.
func (s *Session) Root() string { return s.root }
func (s *Session) ID() string   { return s.desc.ID }

// LastUse 는 idle 정리가 읽는다 (FR-LSP-17).
func (s *Session) LastUse() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastUse
}

// waitReady 는 핸드셰이크를 한 번만 하고 그 결과를 모두가 공유한다.
func (s *Session) waitReady(ctx context.Context) error {
	s.once.Do(func() {
		if s.initErr != nil {
			return
		}
		go s.handshake()
	})
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.ready:
		return s.initErr
	}
}

// handshake 는 `initialize` → `initialized` 다.
//
// 실패를 `initErr` 에 남기고 ready 를 닫는 것이 규칙이다 — 닫지 않으면 그 세션의
// 모든 요청이 영원히 기다린다 (FR-LSP-15 의 "기다린다" 는 답이 올 때까지이지
// 답이 없을 때까지가 아니다).
func (s *Session) handshake() {
	defer close(s.ready)
	ctx, cancel := context.WithTimeout(context.Background(), HandshakeTimeout)
	defer cancel()

	var res map[string]any
	err := s.c.Call(ctx, "initialize", map[string]any{
		// processId 를 싣지 않는다 — 서버가 그 pid 를 지켜보다 우리가 죽으면
		// 함께 죽는 규약인데, 우리 수명은 이미 stop 이 관리한다.
		"rootUri": pathToURI(s.root),
		"workspaceFolders": []map[string]any{{
			"uri":  pathToURI(s.root),
			"name": filepath.Base(s.root),
		}},
		// M2 가 쓰는 것만 밝힌다. 자동완성은 비목표다 (D-7) — 밝히지 않으면
		// 서버가 그 계산을 하지 않으므로 그것이 곧 비용 절약이다.
		"capabilities": map[string]any{
			"textDocument": map[string]any{
				"definition": map[string]any{},
				"references": map[string]any{},
				"hover":      map[string]any{"contentFormat": []string{"markdown", "plaintext"}},
				"synchronization": map[string]any{
					"didSave":           false,
					"willSave":          false,
					"willSaveWaitUntil": false,
				},
				"publishDiagnostics": map[string]any{},
			},
		},
	}, &res)
	if err != nil {
		s.initErr = fmt.Errorf("lsp: %s 의 initialize 가 실패했습니다: %w", s.desc.ID, err)
		return
	}
	if err := s.c.Notify("initialized", map[string]any{}); err != nil {
		s.initErr = fmt.Errorf("lsp: %s 에 initialized 를 보내지 못했습니다: %w", s.desc.ID, err)
	}
}

// sync 는 그 파일의 **현재 텍스트**를 서버에 알린다 (D-3).
//
// 저장 전 편집이 브라우저에만 있으므로(§2.8), 디스크만 보는 서버는 방금 쓴 함수를
// 모른다. 처음이면 `didOpen`, 다음부터는 `didChange` 다.
func (s *Session) sync(path, text string) error {
	uri := pathToURI(path)
	s.mu.Lock()
	ver, seen := s.open[uri]
	ver++
	s.open[uri] = ver
	s.lastUse = time.Now()
	s.mu.Unlock()

	if !seen {
		return s.c.Notify("textDocument/didOpen", map[string]any{
			"textDocument": map[string]any{
				"uri":        uri,
				"languageId": s.languageFor(path),
				"version":    ver,
				"text":       text,
			},
		})
	}
	// 전체 교체다. 증분 동기화는 우리가 편집을 추적해야 하므로 쓰지 않는다 —
	// 요청마다 현재 텍스트가 오는 구조에서는 얻는 것이 없다.
	return s.c.Notify("textDocument/didChange", map[string]any{
		"textDocument":   map[string]any{"uri": uri, "version": ver},
		"contentChanges": []map[string]any{{"text": text}},
	})
}

// languageFor 는 이 파일의 Monaco/LSP language id 다. 서술자가 덮는 언어가 여럿일
// 때(TS·JS) 확장자로 가른다 — 서버가 그것으로 파서를 고른다.
func (s *Session) languageFor(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".ts", ".mts", ".cts":
		return "typescript"
	case ".tsx":
		return "typescriptreact"
	case ".js", ".mjs", ".cjs":
		return "javascript"
	case ".jsx":
		return "javascriptreact"
	}
	if len(s.desc.Langs) > 0 {
		return s.desc.Langs[0]
	}
	return ""
}

// Definition 은 그 자리의 정의들이다 (FR-LSP-21).
func (s *Session) Definition(ctx context.Context, path, text string, line, col int) ([]Location, error) {
	return s.locate(ctx, "textDocument/definition", path, text, line, col, nil)
}

// References 는 그 자리의 참조들이다 (FR-LSP-22).
func (s *Session) References(ctx context.Context, path, text string, line, col int, includeDecl bool) ([]Location, error) {
	return s.locate(ctx, "textDocument/references", path, text, line, col,
		map[string]any{"includeDeclaration": includeDecl})
}

// Hover 는 그 자리 심볼의 타입·문서다 (FR-LSP-29).
//
// **정의 이동과 같은 세션·같은 동기화를 쓴다** (FR-LSP-30) — 두 벌로 두면 한쪽만
// 낡아, 호버는 옛 내용을 말하고 정의는 새 내용을 가리키게 된다.
func (s *Session) Hover(ctx context.Context, path, text string, line, col int) (string, error) {
	if err := s.waitReady(ctx); err != nil {
		return "", err
	}
	if err := s.sync(path, text); err != nil {
		return "", err
	}
	l, ch := toLSPPos(line, col)
	var raw map[string]any
	err := s.c.Call(ctx, "textDocument/hover", map[string]any{
		"textDocument": map[string]any{"uri": pathToURI(path)},
		"position":     map[string]any{"line": l, "character": ch},
	}, &raw)
	if err != nil {
		return "", err
	}
	return hoverText(raw["contents"]), nil
}

// hoverText 는 LSP 의 세 가지 `contents` 모양을 하나의 문자열로 모은다.
//
// 셋을 다 받는 이유는 서버마다 다르기 때문이다 — 하나만 받으면 어떤 서버에서는
// 호버가 늘 비어 보이고, 그 증상은 "호버가 안 된다" 로 읽힌다.
//
//	MarkupContent   {kind, value}
//	MarkedString    "문자열" 또는 {language, value}
//	MarkedString[]  위의 것들의 배열
func hoverText(v any) string {
	switch c := v.(type) {
	case string:
		return strings.TrimSpace(c)
	case map[string]any:
		if s, ok := c["value"].(string); ok {
			return strings.TrimSpace(s)
		}
	case []any:
		var parts []string
		for _, it := range c {
			if s := hoverText(it); s != "" {
				parts = append(parts, s)
			}
		}
		return strings.Join(parts, "\n\n")
	}
	return ""
}

// locate 는 정의·참조가 공유하는 몸통이다 — 둘은 같은 입력과 같은 응답 모양을
// 가지며 method 와 context 만 다르다. 두 벌로 두면 좌표 변환이 한쪽만 고쳐진다.
func (s *Session) locate(ctx context.Context, method, path, text string,
	line, col int, refCtx map[string]any) ([]Location, error) {
	if err := s.waitReady(ctx); err != nil {
		return nil, err
	}
	if err := s.sync(path, text); err != nil {
		return nil, err
	}
	l, ch := toLSPPos(line, col)
	params := map[string]any{
		"textDocument": map[string]any{"uri": pathToURI(path)},
		"position":     map[string]any{"line": l, "character": ch},
	}
	if refCtx != nil {
		params["context"] = refCtx
	}
	// 응답은 세 모양 중 하나다 — Location, Location[], LocationLink[].
	// 서버마다 다르므로 셋을 다 받는다.
	var raw any
	if err := s.c.Call(ctx, method, params, &raw); err != nil {
		return nil, err
	}
	return parseLocations(raw), nil
}

// parseLocations 는 LSP 의 세 응답 모양을 하나로 모은다.
func parseLocations(raw any) []Location {
	var out []Location
	add := func(m map[string]any) {
		uri, _ := m["uri"].(string)
		rng, _ := m["range"].(map[string]any)
		if uri == "" {
			// LocationLink 는 targetUri·targetRange 를 쓴다.
			uri, _ = m["targetUri"].(string)
			if r, ok := m["targetSelectionRange"].(map[string]any); ok {
				rng = r
			} else if r, ok := m["targetRange"].(map[string]any); ok {
				rng = r
			}
		}
		p, err := uriToPath(uri)
		if err != nil {
			return
		}
		line, col := 0, 0
		if rng != nil {
			if st, ok := rng["start"].(map[string]any); ok {
				line = intOf(st["line"])
				col = intOf(st["character"])
			}
		}
		l, c := fromLSPPos(line, col)
		out = append(out, Location{Path: p, Line: l, Col: c})
	}
	switch v := raw.(type) {
	case map[string]any:
		add(v)
	case []any:
		for _, it := range v {
			if m, ok := it.(map[string]any); ok {
				add(m)
			}
		}
	}
	return out
}

func intOf(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return 0
}

// parseDiagnostics 는 `publishDiagnostics` 의 params 를 우리 모양으로 옮긴다.
//
// uri 가 경로로 풀리지 않으면 **버린다** — 어느 파일의 것인지 모르는 진단은 화면이
// 얹을 자리가 없다.
func parseDiagnostics(params json.RawMessage) (Diagnostics, bool) {
	var raw struct {
		URI         string `json:"uri"`
		Diagnostics []struct {
			Range struct {
				Start struct {
					Line      int `json:"line"`
					Character int `json:"character"`
				} `json:"start"`
				End struct {
					Line      int `json:"line"`
					Character int `json:"character"`
				} `json:"end"`
			} `json:"range"`
			Severity int    `json:"severity"`
			Message  string `json:"message"`
			Source   string `json:"source"`
		} `json:"diagnostics"`
	}
	if err := json.Unmarshal(params, &raw); err != nil {
		return Diagnostics{}, false
	}
	path, err := uriToPath(raw.URI)
	if err != nil {
		return Diagnostics{}, false
	}
	// nil 이 아니라 빈 배열이다 — 그 차이가 "깨끗해졌다" 와 "모른다" 를 가른다.
	items := make([]Diagnostic, 0, len(raw.Diagnostics))
	for _, d := range raw.Diagnostics {
		l, c := fromLSPPos(d.Range.Start.Line, d.Range.Start.Character)
		el, ec := fromLSPPos(d.Range.End.Line, d.Range.End.Character)
		sev := d.Severity
		if sev == 0 {
			// LSP 는 severity 를 생략할 수 있다. 그때의 뜻은 "서버가 정하지
			// 않았다" 이며, 에러로 올리면 없는 오류를 만들어 낸다.
			sev = 3
		}
		items = append(items, Diagnostic{
			Line: l, Col: c, EndLine: el, EndCol: ec,
			Severity: sev, Message: d.Message, Source: d.Source,
		})
	}
	return Diagnostics{Path: path, Items: items}, true
}

// Close 는 세션을 정지시킨다 (FR-LSP-17·18).
func (s *Session) Close() {
	if s.c != nil {
		_ = s.c.Close()
	}
	if s.stop != nil {
		s.stop()
	}
}

// ── 좌표와 URI 의 경계 ──
//
// 이 넷이 LSP 의 셈법과 우리 셈법이 만나는 **유일한 자리**다. 흩어 두면 한쪽만
// 고쳐져 정의가 한 줄 위로 뛰고, 그 어긋남은 맞는 것처럼 보인다.

// toLSPPos 는 1-기준을 0-기준으로 옮긴다. 0 이하는 1 로 여민다 — 음수 좌표로
// 서버에 묻지 않는다.
func toLSPPos(line, col int) (int, int) {
	if line < 1 {
		line = 1
	}
	if col < 1 {
		col = 1
	}
	return line - 1, col - 1
}

// fromLSPPos 는 0-기준을 1-기준으로 옮긴다.
func fromLSPPos(line, col int) (int, int) {
	return line + 1, col + 1
}

// pathToURI 는 절대경로를 `file://` URI 로 옮긴다.
//
// **판정은 `platform` 이 한다** (CROSS_PLATFORM_SRS FR-XPL-5). URI 의 모양이 OS
// 마다 다르고(Windows 의 절대경로는 `/` 로 시작하지 않는다), 그 판단이 여기
// 남아 있으면 `scripts/check-seams.sh` 가 그것을 실패로 잡는다 — 실제로 잡고
// 있었다.
func pathToURI(path string) string {
	return platform.Current().Paths.FileURI(path)
}

// uriToPath 는 그 역이다.
func uriToPath(uri string) (string, error) {
	return platform.Current().Paths.PathFromFileURI(uri)
}
