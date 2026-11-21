package apipath

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// serverRouteDirs 는 `/api/*` 라우트를 등록하는 서버 패키지다 (이 파일 기준 상대 경로).
var serverRouteDirs = []string{"../../webserver/httpapi", "../../webserver/gitapi"}

// apiLiterals 는 dir 의 시험이 아닌 Go 파일에 적힌 `/api/` 문자열 리터럴 전부다.
// 서버의 라우트 표·`HandleFunc`·`Under` 접두가 모두 리터럴이므로 이것이 라우트의 상한이다.
func apiLiterals(t *testing.T, dir string) map[string]bool {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil || len(files) == 0 {
		t.Fatalf("서버 소스를 읽지 못했다: %s (%v)", dir, err)
	}
	out := map[string]bool{}
	fset := token.NewFileSet()
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		af, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		ast.Inspect(af, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			if s, err := strconv.Unquote(lit.Value); err == nil && strings.HasPrefix(s, "/api/") {
				out[s] = true
			}
			return true
		})
	}
	return out
}

// ownConsts 는 이 패키지 소스의 상수 이름 → 값이다.
func ownConsts(t *testing.T) map[string]string {
	t.Helper()
	fset := token.NewFileSet()
	af, err := parser.ParseFile(fset, "apipath.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, d := range af.Decls {
		gd, ok := d.(*ast.GenDecl)
		if !ok || gd.Tok != token.CONST {
			continue
		}
		for _, sp := range gd.Specs {
			vs := sp.(*ast.ValueSpec)
			for i, name := range vs.Names {
				lit, ok := vs.Values[i].(*ast.BasicLit)
				if !ok {
					t.Fatalf("%s: 문자열 리터럴이 아니다", name.Name)
				}
				v, err := strconv.Unquote(lit.Value)
				if err != nil {
					t.Fatal(err)
				}
				out[name.Name] = v
			}
		}
	}
	return out
}

// TestPathsMatchServerRoutes 는 상수마다 서버가 같은 문자열로 라우트를 두는지 본다
// (FR-RGS-40). 서버가 경로 이름을 바꾸면 이 시험이 실패한다.
func TestPathsMatchServerRoutes(t *testing.T) {
	routes := map[string]bool{}
	for _, d := range serverRouteDirs {
		if _, err := os.Stat(d); err != nil {
			t.Fatalf("서버 패키지가 없다: %s", d)
		}
		for s := range apiLiterals(t, d) {
			routes[s] = true
		}
	}
	consts := ownConsts(t)
	if len(consts) == 0 {
		t.Fatal("상수를 하나도 읽지 못했다")
	}
	for name, v := range consts {
		if !routes[v] {
			t.Errorf("%s = %q — 서버 라우트에 없다", name, v)
		}
	}
}
