package wsentry

import (
	"go/ast"
	"go/parser"
	"go/token"
	"reflect"
	"testing"
)

// 연동 4규칙은 순수 함수다 (FR-EDT-36). 아래 표는 "한 겹만 적용된다"를 값으로
// 확인하고, 마지막 테스트가 "서로를 호출하지 않는다"를 코드로 확인한다.

func TestLinkPinAdd_CreatesEditorRow(t *testing.T) {
	// V-EDT-17 (FR-EDT-31)
	got := LinkPinAdd(Lists{}, absWorkRepo, absHomeU)
	want := Lists{Pinned: []string{absWorkRepo}, Editors: []string{absWorkRepo}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got=%v want=%v", got, want)
	}
	// 이미 있으면 아무 일도 하지 않는다.
	again := LinkPinAdd(got, absWorkRepo, absHomeU)
	if !reflect.DeepEqual(again, want) {
		t.Fatalf("멱등이 아니다: %v", again)
	}
}

func TestLinkPinAdd_HomeMakesNoEditorRow(t *testing.T) {
	// V-EDT-25 (FR-EDT-37)
	got := LinkPinAdd(Lists{}, absHomeU, absHomeU)
	if len(got.Editors) != 0 {
		t.Fatalf("홈 핀이 editor 행을 만들었다: %v", got.Editors)
	}
	if len(got.Pinned) != 1 || got.Pinned[0] != absHomeU {
		t.Fatalf("pinned=%v", got.Pinned)
	}
}

func TestLinkPinRemove_RemovesEditorRow(t *testing.T) {
	// V-EDT-18 (FR-EDT-32)
	cur := Lists{Pinned: []string{absA, absB}, Editors: []string{absA, absB}}
	got := LinkPinRemove(cur, absA, absHomeU)
	want := Lists{Pinned: []string{absB}, Editors: []string{absB}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got=%v want=%v", got, want)
	}
	// 없는 것을 지워도 아무 일도 없다.
	if again := LinkPinRemove(got, "/zzz", absHomeU); !reflect.DeepEqual(again, want) {
		t.Fatalf("없는 핀 제거가 목록을 바꿨다: %v", again)
	}
}

func TestLinkPinRemove_HomeKeepsNothingToRemove(t *testing.T) {
	// V-EDT-25 (FR-EDT-38): 홈은 애초에 editors.list 에 없다. 손상된 문서로
	// 들어 있더라도 root 행의 근거를 지우지 않는다.
	cur := Lists{Pinned: []string{absHomeU}, Editors: []string{absHomeU}}
	got := LinkPinRemove(cur, absHomeU, absHomeU)
	if len(got.Pinned) != 0 {
		t.Fatalf("pinned=%v", got.Pinned)
	}
	if len(got.Editors) != 1 {
		t.Fatalf("홈 unpin 이 root 행 경로를 지웠다: %v", got.Editors)
	}
}

func TestLinkEditorAdd_PinsRepoRootOnly(t *testing.T) {
	// V-EDT-19·20 (FR-EDT-33)
	root := LinkEditorAdd(Lists{}, absWorkRepo, absHomeU, true)
	if len(root.Pinned) != 1 || root.Pinned[0] != absWorkRepo {
		t.Fatalf("저장소 루트인데 핀이 없다: %v", root.Pinned)
	}
	inside := LinkEditorAdd(Lists{}, absWorkRepoSub, absHomeU, false)
	if len(inside.Pinned) != 0 {
		t.Fatalf("루트가 아닌데 핀이 생겼다: %v", inside.Pinned)
	}
	if len(inside.Editors) != 1 {
		t.Fatalf("editors=%v", inside.Editors)
	}
}

func TestLinkEditorAdd_HomeIsNoop(t *testing.T) {
	// V-EDT-8 (FR-EDT-16): root 행이 그 경로를 대표하므로 목록이 변하지 않는다.
	got := LinkEditorAdd(Lists{}, absHomeU, absHomeU, true)
	if len(got.Editors) != 0 || len(got.Pinned) != 0 {
		t.Fatalf("홈 추가가 목록을 바꿨다: %v", got)
	}
}

func TestLinkEditorRemove_RemovesPin(t *testing.T) {
	// V-EDT-21 (FR-EDT-34)
	cur := Lists{Pinned: []string{absA}, Editors: []string{absA}}
	got := LinkEditorRemove(cur, absA, absHomeU)
	if len(got.Pinned) != 0 || len(got.Editors) != 0 {
		t.Fatalf("got=%v", got)
	}
}

// V-EDT-25 (FR-EDT-38a): 홈은 네 방향 **전부** 무동작이다. 제거 쪽만 예외가
// 빠져 있으면 `editors/remove ~` 가 홈의 git 핀만 지운다 — 사용자가 지운 적
// 없는 핀이 사라진다.
func TestLinkEditorRemove_HomeIsNoop(t *testing.T) {
	home := absHomeU
	cur := Lists{Pinned: []string{home, "/other"}, Editors: []string{"/other"}}
	got := LinkEditorRemove(cur, home, home)
	if len(got.Pinned) != 2 || got.Pinned[0] != home {
		t.Fatalf("홈 핀이 지워졌다: %v", got.Pinned)
	}
	if len(got.Editors) != 1 {
		t.Fatalf("행이 바뀌었다: %v", got.Editors)
	}
}

// V-EDT-23 (FR-EDT-36): 규칙은 사용자 조작 한 번에 **한 겹**만 적용된다. 서로를
// 부르면 pin→editor→pin 으로 겹이 늘고, 그 순간 규칙의 결과가 호출 순서에 달린다.
func TestLinkRulesDoNotCallEachOther(t *testing.T) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "link.go", nil, 0)
	if err != nil {
		t.Fatalf("link.go 파싱: %v", err)
	}
	rules := map[string]bool{
		"LinkPinAdd": true, "LinkPinRemove": true,
		"LinkEditorAdd": true, "LinkEditorRemove": true,
	}
	seen := map[string]bool{}
	for _, d := range f.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || !rules[fn.Name.Name] {
			continue
		}
		seen[fn.Name.Name] = true
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			id, ok := n.(*ast.Ident)
			if ok && rules[id.Name] {
				t.Errorf("%s 가 %s 를 부른다 — 연동이 두 겹 적용된다", fn.Name.Name, id.Name)
			}
			return true
		})
	}
	for name := range rules {
		if !seen[name] {
			t.Errorf("%s 가 link.go 에 없다", name)
		}
	}
}
