package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-4-2 (IPC-8): 겹 스탬프(`/api/fs/stamp`)와 파일 표식
// (`/api/file/stamps`)을 요청 하나로 묻는다. 값은 두 종단과 **같은 함수**에서 나와야
// 한다 — 갈리면 조회로 기억한 값과 폴링으로 견주는 값이 어긋난다 (FR-FSL-10 · FR-ELR-2).

func stampsCombined(t *testing.T, s *Server, body any) (int, map[string]any) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return fsReq(t, s, http.MethodPost, "/api/fs/stamps", string(b))
}

func treeOf(t *testing.T, out map[string]any, root string) map[string]any {
	t.Helper()
	trees, ok := out["trees"].(map[string]any)
	if !ok {
		t.Fatalf("trees 가 없다: %v", out)
	}
	e, ok := trees[root].(map[string]any)
	if !ok {
		t.Fatalf("%s 의 답이 없다: %v", root, trees)
	}
	return e
}

func TestFSStamps_AnswersTreesAndPathsInOne(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := t.TempDir()
	sub := filepath.Join(root, "sub")
	file := filepath.Join(root, "a.txt")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	seedRoot(t, ws, root)

	code, out := stampsCombined(t, srv, map[string]any{
		"trees": []any{map[string]any{"root": root, "dirs": []string{root, sub}}},
		"paths": []string{file, filepath.Join(root, "missing.txt")},
	})
	if code != http.StatusOK {
		t.Fatalf("code=%d %v", code, out)
	}
	got := stampsOf(t, treeOf(t, out, root))
	_, legacy := stampReq(t, srv, root, []string{root, sub})
	want := stampsOf(t, legacy)
	if len(got) != 2 || got[root] != want[root] || got[sub] != want[sub] {
		t.Fatalf("겹 스탬프 = %v, 옛 종단은 %v", got, want)
	}
	paths, _ := out["paths"].(map[string]any)
	if paths[file] != stampOfPath(file) || stampOfPath(file) == "" {
		t.Fatalf("파일 표식 = %v, want %q", paths, stampOfPath(file))
	}
	// FR-ELR-5: 없는 파일은 오류가 아니라 **빠진다.**
	if _, has := paths[filepath.Join(root, "missing.txt")]; has || len(paths) != 1 {
		t.Fatalf("없는 파일이 답에 들었다: %v", paths)
	}
}

// 루트 하나의 사정이 다른 루트와 파일의 답을 막지 않는다. 그 루트의 답에는 옛 종단이
// 상태 코드로 말하던 판정이 `code`·`status` 로 실린다 — 클라이언트가 같은 규칙(4xx 는
// 굳힌다, FR-FSL-12)을 적용할 수 있어야 한다.
func TestFSStamps_OneBadRootDoesNotBlockOthers(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	good := t.TempDir()
	stray := t.TempDir()
	seedRoot(t, ws, good)

	code, out := stampsCombined(t, srv, map[string]any{
		"trees": []any{
			map[string]any{"root": stray, "dirs": []string{stray}},
			map[string]any{"root": good, "dirs": []string{good}},
		},
	})
	if code != http.StatusOK {
		t.Fatalf("code=%d %v", code, out)
	}
	bad := treeOf(t, out, stray)
	legacyCode, legacy := stampReq(t, srv, stray, []string{stray})
	if bad["code"] != legacy["code"] || bad["status"] != float64(legacyCode) {
		t.Fatalf("루트 밖 판정 = %v, 옛 종단은 %d %v", bad, legacyCode, legacy)
	}
	if _, has := bad["stamps"]; has {
		t.Fatalf("거부된 루트가 스탬프를 실었다: %v", bad)
	}
	if st := stampsOf(t, treeOf(t, out, good)); st[good] == "" {
		t.Fatalf("다른 루트의 답이 막혔다: %v", st)
	}
	if _, ok := out["paths"].(map[string]any); !ok {
		t.Fatalf("paths 가 빈 맵으로라도 와야 한다: %v", out)
	}
}

// FR-FSL-5 · FR-ELR-6: 상한은 옛 종단과 같다. 넘기면 요청 전체가 bad_request 다.
func TestFSStamps_Limits(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := t.TempDir()
	seedRoot(t, ws, root)
	many := func(n int) []string {
		out := make([]string, n)
		for i := range out {
			out[i] = filepath.Join(root, "f")
		}
		return out
	}
	if code, _ := stampsCombined(t, srv, map[string]any{"paths": many(fileStampsMax + 1)}); code != http.StatusBadRequest {
		t.Fatalf("paths 상한 초과가 %d 로 답했다", code)
	}
	trees := make([]any, fsStampsTreesMax+1)
	for i := range trees {
		trees[i] = map[string]any{"root": root, "dirs": []string{root}}
	}
	if code, _ := stampsCombined(t, srv, map[string]any{"trees": trees}); code != http.StatusBadRequest {
		t.Fatalf("trees 상한 초과가 %d 로 답했다", code)
	}
	code, out := stampsCombined(t, srv, map[string]any{
		"trees": []any{map[string]any{"root": root, "dirs": many(fsStampMax + 1)}},
	})
	if code != http.StatusOK || treeOf(t, out, root)["code"] != fsErrBadRequest {
		t.Fatalf("dirs 상한 초과는 그 루트의 판정이어야 한다: %d %v", code, out)
	}
}
