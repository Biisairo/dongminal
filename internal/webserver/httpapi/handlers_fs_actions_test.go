package httpapi

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/wsentry"
)

// SERVER_DRIVEN_ACTIONS_SRS 묶음 F-1 (FR-SDA-50·51 · TC-SDA-1·8).

// fsActionsTree 는 Editor 루트 하나와 그 아래 `tree/`(파일 셋)·`file.txt` 를 만든다.
func fsActionsTree(t *testing.T) (*Server, *fakeWorkspaceStore, string) {
	t.Helper()
	s, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)
	if err := os.MkdirAll(filepath.Join(root, "tree", "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"tree/a", "tree/sub/b", "file.txt"} {
		if err := os.WriteFile(filepath.Join(root, n), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return s, ws, root
}

func postFSActions(t *testing.T, s *Server, root string, paths ...string) (int, map[string]any) {
	t.Helper()
	body := `{"root":` + testpath.JSONQuote(root) + `,"paths":[`
	for i, p := range paths {
		if i > 0 {
			body += ","
		}
		body += testpath.JSONQuote(p)
	}
	return fsReq(t, s, http.MethodPost, "/api/fs/actions", body+`]}`)
}

func fsAnswerOf(t *testing.T, out map[string]any, id string) map[string]any {
	t.Helper()
	acts, _ := out["actions"].(map[string]any)
	a, _ := acts[id].(map[string]any)
	if a == nil {
		t.Fatalf("답 %s 가 없다: %v", id, out)
	}
	return a
}

func wantFSAnswer(t *testing.T, out map[string]any, id, why string) {
	t.Helper()
	a := fsAnswerOf(t, out, id)
	if why == "" {
		if a["ok"] != true {
			t.Errorf("%s = %v, want ok", id, a)
		}
		return
	}
	if a["ok"] != false || a["why"] != why {
		t.Errorf("%s = %v, want why=%s", id, a, why)
	}
	if !action.Catalog.MayGive(id, why) {
		t.Errorf("%s 의 사유 %s 가 action.Catalog 에 없다", id, why)
	}
}

// F-c: 보호 판정은 대상의 종류마다 다른 코드다.
func TestFSProtectAnswer(t *testing.T) {
	s, ws, home := fsTestServer(t)
	outer := wsentry.NormalizePath(filepath.Dir(home))
	other := wsentry.NormalizePath(t.TempDir())
	ws.raw = []byte(fmt.Sprintf(`{"schemaVersion":2,"editors":{"list":[%q,%q]}}`, outer, other))
	plain := filepath.Join(other, "x")

	cases := []struct {
		name, root, target, want string
	}{
		{"루트 자신", other, other, apierr.CodeEditorRootProtected},
		{"다른 Editor 루트", outer, other, apierr.CodeEditorRootProtected},
		{"홈", outer, home, apierr.CodeHomeProtected},
		{"파일시스템 루트", other, testpath.Root(), apierr.CodeFilesystemRootProtected},
		{"보통 경로", other, plain, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := s.fsProtectAnswer(c.root, c.target)
			if a.Why != c.want || a.OK != (c.want == "") {
				t.Fatalf("answer = %+v, want why=%q", a, c.want)
			}
			if !a.OK && a.Status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", a.Status)
			}
		})
	}
}

// F-a·F-b: 메뉴 답과 항목 수.
func TestFSActions_AnswersAndCount(t *testing.T) {
	s, _, root := fsActionsTree(t)
	tree, file := filepath.Join(root, "tree"), filepath.Join(root, "file.txt")

	code, out := postFSActions(t, s, root, tree, file)
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	for _, id := range []string{action.FSRename, action.FSMove, action.FSCopy, action.FSDelete} {
		wantFSAnswer(t, out, id, "")
	}
	// tree 안: a·sub·sub/b = 3. 대상 자신과 파일은 세지 않는다.
	if out["count"] != float64(3) {
		t.Fatalf("count = %v, want 3", out["count"])
	}
}

func TestFSActions_TooManyEntries(t *testing.T) {
	s, _, root := fsActionsTree(t)
	s.limits.fsDelete = 2
	tree, file := filepath.Join(root, "tree"), filepath.Join(root, "file.txt")

	// 메뉴를 연 행은 file 이고, 넘치는 것은 선택의 나머지(tree)다.
	_, out := postFSActions(t, s, root, file, tree)
	wantFSAnswer(t, out, action.FSDelete, apierr.CodeTooManyEntries)
	wantFSAnswer(t, out, action.FSRename, "")
	a := fsAnswerOf(t, out, action.FSDelete)
	if args, _ := a["args"].(map[string]any); args["max"] != float64(2) {
		t.Fatalf("args = %v, want max=2", a["args"])
	}
}

func TestFSActions_RootAndMissing(t *testing.T) {
	s, _, root := fsActionsTree(t)

	_, out := postFSActions(t, s, root, root)
	for _, id := range []string{action.FSRename, action.FSMove, action.FSDelete} {
		wantFSAnswer(t, out, id, apierr.CodeEditorRootProtected)
	}
	wantFSAnswer(t, out, action.FSCopy, "")

	_, out = postFSActions(t, s, root, filepath.Join(root, "gone"))
	for _, id := range []string{action.FSRename, action.FSMove, action.FSCopy, action.FSDelete} {
		wantFSAnswer(t, out, id, apierr.CodeNotFound)
	}
}

// UX_BATCH12 TC-EXM-7 (FR-EXM-5): 옮기기·복사는 선택 전부를 본다. 이름 바꾸기는 첫 경로다.
func TestFSActions_MoveCopyJudgeAllPaths(t *testing.T) {
	s, _, root := fsActionsTree(t)
	file := filepath.Join(root, "file.txt")

	_, out := postFSActions(t, s, root, file, filepath.Join(root, "gone"))
	wantFSAnswer(t, out, action.FSMove, apierr.CodeNotFound)
	wantFSAnswer(t, out, action.FSCopy, apierr.CodeNotFound)
	wantFSAnswer(t, out, action.FSRename, "")

	_, out = postFSActions(t, s, root, file, root)
	wantFSAnswer(t, out, action.FSMove, apierr.CodeEditorRootProtected)
	wantFSAnswer(t, out, action.FSCopy, "")
	wantFSAnswer(t, out, action.FSRename, "")
}

func TestFSActions_BadRequests(t *testing.T) {
	s, _, root := fsActionsTree(t)
	if code, out := postFSActions(t, s, root); code != http.StatusBadRequest || out["code"] != apierr.CodeBadRequest {
		t.Fatalf("빈 paths: code=%d body=%v", code, out)
	}
	if code, out := postFSActions(t, s, root, filepath.Dir(root)); code != http.StatusForbidden || out["code"] != apierr.CodeOutsideRoot {
		t.Fatalf("루트 밖: code=%d body=%v", code, out)
	}
}

// TC-SDA-1: 답이 거짓이면 실행이 같은 코드로 거절되고, 서버 문구는 싣지 않는다(F-e).
func TestFSActions_RejectionMatchesAnswer(t *testing.T) {
	s, ws, root := fsActionsTree(t)
	inner := filepath.Join(root, "tree")
	ws.raw = []byte(fmt.Sprintf(`{"schemaVersion":2,"editors":{"list":[%q,%q]}}`, root, inner))

	wantReject := func(t *testing.T, path, body, why string) map[string]any {
		t.Helper()
		code, out := fsReq(t, s, http.MethodPost, path, body)
		if code != http.StatusBadRequest || out["code"] != why {
			t.Fatalf("%s: code=%d body=%v, want 400 %s", path, code, out, why)
		}
		if _, has := out["message"]; has {
			t.Fatalf("%s: 거절에 서버 문구가 실렸다: %v", path, out)
		}
		return out
	}

	_, out := postFSActions(t, s, root, inner)
	wantFSAnswer(t, out, action.FSDelete, apierr.CodeEditorRootProtected)
	wantReject(t, "/api/fs/delete",
		`{"root":`+testpath.JSONQuote(root)+`,"path":`+testpath.JSONQuote(inner)+`}`, apierr.CodeEditorRootProtected)
	// 이름 바꾸기·옮기기도 같은 보호를 받는다 — 이전에는 받지 않았다.
	wantFSAnswer(t, out, action.FSRename, apierr.CodeEditorRootProtected)
	wantReject(t, "/api/fs/rename",
		`{"root":`+testpath.JSONQuote(root)+`,"from":`+testpath.JSONQuote(inner)+`,"to":`+testpath.JSONQuote(inner+"2")+`}`,
		apierr.CodeEditorRootProtected)
	if _, err := os.Stat(inner); err != nil {
		t.Fatalf("다른 Editor 루트가 옮겨졌다: %v", err)
	}

	// 상한 초과: Editor 루트가 아닌 하위 폴더(sub 와 그 안의 b = 2개)를 상한 1 로 본다.
	sub := filepath.Join(inner, "sub")
	s.limits.fsDelete = 1
	_, out = postFSActions(t, s, root, sub)
	wantFSAnswer(t, out, action.FSDelete, apierr.CodeTooManyEntries)
	got := wantReject(t, "/api/fs/delete",
		`{"root":`+testpath.JSONQuote(root)+`,"path":`+testpath.JSONQuote(sub)+`}`, apierr.CodeTooManyEntries)
	if args, _ := got["args"].(map[string]any); args["max"] != float64(1) {
		t.Fatalf("거절의 args = %v, want max=1", got["args"])
	}

	// 복사의 상한 초과도 같은 사유다.
	s.limits.fsCopy = 1
	wantReject(t, "/api/fs/copy",
		`{"srcRoot":`+testpath.JSONQuote(root)+`,"src":`+testpath.JSONQuote(sub)+
			`,"dstRoot":`+testpath.JSONQuote(root)+`,"dstDir":`+testpath.JSONQuote(root)+`}`,
		apierr.CodeTooManyEntries)
}

func TestFSActionsRouteRegistered(t *testing.T) {
	for _, rt := range apiRoutes {
		if rt.Method == http.MethodPost && rt.Match("/api/fs/actions") {
			return
		}
	}
	t.Fatal("POST /api/fs/actions 가 apiRoutes 에 없다")
}
