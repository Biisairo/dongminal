package lsp

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"dongminal/internal/webserver/domain/ext"
)

// rwc 는 가짜 언어 서버 프로세스의 stdio 다.
type rwc struct {
	io.Reader
	io.Writer
	closeFn func() error
}

func (x rwc) Close() error { return x.closeFn() }

type int32Counter struct {
	mu sync.Mutex
	n  int
}

func (c *int32Counter) inc() {
	c.mu.Lock()
	c.n++
	c.mu.Unlock()
}
func (c *int32Counter) get() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// goPackDecl 은 검사가 놓는 플러그인 선언이다.
//
// **목록이 코드에 없으므로**(FR-EXT-1) 검사도 파일로 놓는다 — 종전처럼 전역 표를
// 부르면 재는 것이 제품과 달라진다.
const goPackDecl = `{
  "id":"gopls","kind":"server","version":"v0",
  "source":{"kind":"toolchain","tool":"go","args":["install","x@v1"],"bin":"bin"},
  "servers":[{"id":"gopls","langs":["go"],"exts":[".go"],"exe":"gopls"}]
}`

// tsPackDecl 은 **하나가 여럿을 덮는** 팩이다 — TS 와 JS 가 한 서버를 쓴다
// (FR-EXT-4 / FR-LSP-13).
const tsPackDecl = `{
  "id":"typescript","kind":"server","version":"v0",
  "source":{"kind":"toolchain","tool":"go","args":["install","x@v1"],"bin":"bin"},
  "servers":[{"id":"typescript-language-server",
    "langs":["typescript","javascript"],
    "exts":[".ts",".tsx",".mts",".cts",".js",".jsx",".mjs",".cjs"],
    "exe":"typescript-language-server","args":["--stdio"]}]
}`

func svcWith(t *testing.T, start Starter, onPath map[string]string) *Service {
	t.Helper()
	root := t.TempDir()
	for id, decl := range map[string]string{"gopls": goPackDecl, "typescript": tsPackDecl} {
		dir := ext.PluginDir(root, id)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, ext.ManifestName), []byte(decl), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	e := &ext.Service{
		Root: root,
		LookPath: func(name string) (string, error) {
			if p, ok := onPath[name]; ok {
				return p, nil
			}
			return "", errors.New("not found")
		},
	}
	svc := &Service{Ext: e, Start: start}
	t.Cleanup(svc.Shutdown)
	return svc
}

// TC-LSP-70 (FR-LSP-13·14): 세션은 (루트, 서술자)마다 하나이며 **필요할 때** 선다.
// 같은 루트의 두 `.go` 파일이 한 프로세스를 공유한다.
