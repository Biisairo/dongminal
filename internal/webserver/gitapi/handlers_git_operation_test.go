package gitapi

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// 묶음 A 서버측 — /api/git/operation (GIT_ACTIONS_SRS §3.1 FR-GIT-252, 검증 V176).
//
// **서버가 마지막 방어선이다.** 중단의 확인과 "화면이 아는 작업과 실제가 같은가"를
// 클라이언트만 막으면 API 직접 호출이 그대로 우회한다.

// opInProgress 는 fake 의 gitdir 에 표식을 심어 진행 중 상태를 만든다 — 판정이
// 파일을 보므로 테스트도 파일로 만든다 (query 쪽과 같은 근거).
func opInProgress(t *testing.T, f *gitM5Fake, name string) {
	t.Helper()
	if err := os.Mkdir(filepath.Join(f.gitDir, name), 0o755); err != nil {
		t.Fatal(err)
	}
}

// OP1 (FR-GIT-89·252): 중단은 `confirm:true` 없이 400 이고 **실행되지 않는다.**
// 그 작업 중 해결한 내용이 사라지고 되살릴 값이 없다.
func TestAPIGitOperation_AbortRequiresConfirm(t *testing.T) {
	f := newGitM5Fake(t)
	opInProgress(t, f, "rebase-merge")
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/operation",
		`{"repo":"/work/repo","kind":"rebase","action":"abort"}`)
	if code != http.StatusBadRequest || out["error"] != gitErrConfirmRequired {
		t.Fatalf("→ %d %v, want 400 %s", code, out["error"], gitErrConfirmRequired)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("확인 없이 실행됐다: %v", w)
	}
}

// OP2: 그 종류에 없는 동작(merge 의 skip)과 모르는 조합은 **실행 전에** 400 이다.
// gitApply 를 지나면 500 이 되어 클라이언트가 자기 요청이 틀렸음을 알 수 없다.
func TestAPIGitOperation_RejectsUnknownCombo(t *testing.T) {
	for _, body := range []string{
		`{"repo":"/work/repo","kind":"merge","action":"skip"}`,
		`{"repo":"/work/repo","kind":"bisect","action":"abort","confirm":true}`,
		`{"repo":"/work/repo","kind":"rebase","action":"start"}`,
	} {
		f := newGitM5Fake(t)
		opInProgress(t, f, "rebase-merge")
		s := gitM5Server(t, f)
		code, out := gitReq(t, s, http.MethodPost, "/api/git/operation", body)
		if code != http.StatusBadRequest {
			t.Fatalf("%s → %d %v, want 400", body, code, out["error"])
		}
		if w := f.wrote(); len(w) != 0 {
			t.Fatalf("%s: 거부해야 하는데 실행됐다: %v", body, w)
		}
	}
}

// OP3 (FR-GIT-252): 화면이 아는 작업과 저장소의 작업이 다르면 실행하지 않는다.
// 낡은 화면의 `rebase --abort` 가 남의 머지를 깨서는 안 된다.
func TestAPIGitOperation_MismatchIsRefused(t *testing.T) {
	// 진행 중인 것이 없는데 중단을 보낸 경우.
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/operation",
		`{"repo":"/work/repo","kind":"rebase","action":"abort","confirm":true}`)
	if code != http.StatusConflict || out["error"] != gitErrNoOperation {
		t.Fatalf("→ %d %v, want 409 %s", code, out["error"], gitErrNoOperation)
	}
	if w := f.wrote(); len(w) != 0 {
		t.Fatalf("진행 중이 아닌데 실행됐다: %v", w)
	}

	// 머지 중인데 리베이스 중단을 보낸 경우.
	f2 := newGitM5Fake(t)
	if err := os.WriteFile(filepath.Join(f2.gitDir, "MERGE_HEAD"), []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	s2 := gitM5Server(t, f2)
	code, out = gitReq(t, s2, http.MethodPost, "/api/git/operation",
		`{"repo":"/work/repo","kind":"rebase","action":"abort","confirm":true}`)
	if code != http.StatusConflict || out["error"] != gitErrOperationMismatch {
		t.Fatalf("→ %d %v, want 409 %s", code, out["error"], gitErrOperationMismatch)
	}
	if w := f2.wrote(); len(w) != 0 {
		t.Fatalf("어긋났는데 실행됐다: %v", w)
	}
}

// OP4: 맞는 조합은 그 종류의 argv 로 실행된다.
func TestAPIGitOperation_RunsMatchingAction(t *testing.T) {
	for _, tc := range []struct {
		marker, body string
		want         string
	}{
		{"rebase-merge", `{"repo":"/work/repo","kind":"rebase","action":"continue"}`, "rebase --continue"},
		{"rebase-merge", `{"repo":"/work/repo","kind":"rebase","action":"skip"}`, "rebase --skip"},
		{"rebase-merge", `{"repo":"/work/repo","kind":"rebase","action":"abort","confirm":true}`, "rebase --abort"},
	} {
		f := newGitM5Fake(t)
		opInProgress(t, f, tc.marker)
		s := gitM5Server(t, f)
		code, out := gitReq(t, s, http.MethodPost, "/api/git/operation", tc.body)
		if code != http.StatusOK || out["ok"] != true {
			t.Fatalf("%s → %d %v", tc.body, code, out)
		}
		w := f.wrote()
		if len(w) != 1 {
			t.Fatalf("%s: 쓰기가 %d회다: %v", tc.body, len(w), w)
		}
		if got := w[0][0] + " " + w[0][1]; got != tc.want {
			t.Fatalf("%s: argv = %v, want %q", tc.body, w[0], tc.want)
		}
	}
}

// OP5: 라우트가 등록돼 있고 Git 이 없으면 503 이다 (다른 표면과 같은 규약).
func TestAPIGitOperation_RouteRegisteredAndUnavailable(t *testing.T) {
	found := false
	for _, rt := range routes {
		if rt.method == http.MethodPost && rt.match("/api/git/operation") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("/api/git/operation 이 gitapi.routes 에 없다")
	}
	s := &GitServer{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	code, out := gitReq(t, s, http.MethodPost, "/api/git/operation",
		`{"repo":"/work/repo","kind":"rebase","action":"continue"}`)
	if code != http.StatusServiceUnavailable || out["error"] != gitErrUnavailable {
		t.Fatalf("→ %d %v, want 503 %s", code, out["error"], gitErrUnavailable)
	}
}
