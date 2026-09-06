package ext

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"testing"
)

// TC-EXT-9 (FR-EXT-1 / V-EXT-1): **이 패키지의 코드에 서버 목록이 없다.**
//
// 이것이 "플러그인" 이라는 말의 내용이다 (D-P1·D-P2). 기본 셋이 편의를 이유로 코드에
// 돌아오면 서버를 하나 더하는 일이 다시 릴리스를 요구하게 되고, 그 순간 매니페스트는
// 장식이 된다. 그리고 우리가 그 이름을 코드에 적는 순간 우리는 집행기가 아니라
// 배포자가 된다.
//
// 재는 것은 **문자열 리터럴**이며 주석은 아니다. 재려는 것이 "코드가 그 이름으로
// 동작하는가" 이기 때문이다 — 주석이 gopls 를 예로 드는 것은 설명이고, 그것까지
// 막으면 이 저장소가 이유를 적어 두는 방식을 검사가 금지하게 된다.
//
// 검사 파일은 뺀다. 픽스처에는 실제 이름이 있어야 실제를 잰다.
func TestNoServerNamesInCode(t *testing.T) {
	// 서버·패키지·조달처의 고유명들. 조달 **방법**의 이름(npm·go·archive)이나
	// 도구의 배치 규약(`node_modules/.bin`)은 여기 없다 — 그것은 우리가 알아야
	// 하는 규약이지 무엇이 존재하는지에 대한 앎이 아니다.
	banned := []string{
		"gopls", "pyright", "typescript-language-server", "yaml-language-server",
		"vscode-langservers-extracted", "svg-language-server",
		"nodejs.org", "npmjs.org", "golang.org/x/tools",
	}

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	var lits int
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			lit, ok := n.(*ast.BasicLit)
			if !ok || lit.Kind != token.STRING {
				return true
			}
			lits++
			for _, b := range banned {
				if strings.Contains(lit.Value, b) {
					t.Errorf("%s:%d 의 리터럴 %s 에 %q 가 있다 — 목록은 매니페스트의 것이다 (FR-EXT-1)",
						name, fset.Position(lit.Pos()).Line, lit.Value, b)
				}
			}
			return true
		})
	}
	// 아무것도 읽지 않고 통과하는 검사는 아무것도 지키지 않는다.
	if lits == 0 {
		t.Fatal("검사할 문자열 리터럴을 하나도 읽지 못했다")
	}
}
