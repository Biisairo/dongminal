package main

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"testing"
)

// TC-HRB-4 (HOT_REBIND_SRS FR-HRB-11): 서버는 자기 바인드를 환경변수에 넣지 않는다.
// 넣으면 데몬과 셸이 옛 값을 물려받는다.
func TestServerSetsNoBindEnv(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	scanned := 0
	for _, name := range files {
		if filepath.Ext(name) != ".go" || len(name) > 8 && name[len(name)-8:] == "_test.go" {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		scanned++
		ast.Inspect(f, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok || len(call.Args) == 0 {
				return true
			}
			fn, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || fn.Sel.Name != "Setenv" {
				return true
			}
			if arg, ok := call.Args[0].(*ast.SelectorExpr); ok && (arg.Sel.Name == "EnvPort" || arg.Sel.Name == "EnvHost") {
				t.Errorf("%s: 바인드 환경변수 %s 를 넣는다", fset.Position(call.Pos()), arg.Sel.Name)
			}
			return true
		})
	}
	if scanned < 5 {
		t.Fatalf("훑은 파일이 %d 개뿐이다", scanned)
	}
}
