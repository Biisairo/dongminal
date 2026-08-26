package server

import (
	"net/http"
	"testing"
)

// 커밋 축의 HTTP 표면 (FR-GIT-138·139·54). 식별자에 리비전이 들어가므로
// requested 가 oid·parentOid 를 함께 되돌려줘야 한다 — 머지 커밋에서 부모를
// 바꿨을 때 이전 응답을 폐기할 수 있어야 한다.

func TestAPIGitDiffContent_CommitAxisEchoesRevisions(t *testing.T) {
	f := newGitDiffFake(t)
	f.blobs["aaa:a.txt"] = "new\n"
	f.blobs["bbb:a.txt"] = "old\n"
	s := gitDiffServer(t, f)
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/diff-content?repo="+f.root+"&axis=commit-parent&path=a.txt&oid=aaa&parentOid=bbb", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d: %+v", code, out)
	}
	req, _ := out["requested"].(map[string]any)
	if req == nil {
		t.Fatalf("requested 가 없다: %+v", out)
	}
	for k, want := range map[string]string{
		"axis": "commit-parent", "oid": "aaa", "parentOid": "bbb", "path": "a.txt",
	} {
		if got, _ := req[k].(string); got != want {
			t.Fatalf("requested[%q] = %q, want %q", k, got, want)
		}
	}
	orig, _ := out["original"].(map[string]any)
	mod, _ := out["modified"].(map[string]any)
	if orig["content"] != "old\n" || mod["content"] != "new\n" {
		t.Fatalf("축의 좌우가 뒤바뀌었다: orig=%v mod=%v", orig["content"], mod["content"])
	}
}

// 리비전이 - 로 시작하면 400 이다 — git 이 옵션으로 읽는다.
func TestAPIGitDiffContent_CommitAxisRejectsOptionLikeRev(t *testing.T) {
	f := newGitDiffFake(t)
	s := gitDiffServer(t, f)
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/diff-content?repo="+f.root+"&axis=commit-parent&path=a.txt&oid=-x", "")
	if code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400: %+v", code, out)
	}
	if out["error"] != gitErrBadRequest {
		t.Fatalf("error = %v, want %q", out["error"], gitErrBadRequest)
	}
}
