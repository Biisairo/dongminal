package gitapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 묶음 F 서버측 — /api/git/{ignore,file-head,uncommitted/*}, /api/git/stash/branch
// (GIT_ACTIONS_SRS §3.6 FR-GIT-272~275·277, 검증 V199·V200·V203).
//
// **서버가 마지막 방어선이다.** `.gitignore` 의 경로 이탈과 Clean 의 2단계 확인을
// 클라이언트만 막으면 API 직접 호출이 그대로 우회한다.

// gitIgnoreStatus 는 untracked 하나를 가진 status 다. clean 의 "지울 것이 있는지"
// 판정이 이것을 딛는다.
func gitIgnoreStatus(path string) string {
	return strings.Join([]string{
		"# branch.oid " + strings.Repeat("a", 40),
		"# branch.head main",
		"? " + path,
	}, "\x00") + "\x00"
}

// gitInitialStatus 는 커밋이 없는 저장소의 status 다.
func gitInitialStatus() string {
	return strings.Join([]string{
		"# branch.oid (initial)",
		"# branch.head main",
	}, "\x00") + "\x00"
}

// F1 (V200): 저장소 루트 밖을 대상으로 삼지 않는다. **쓰지 않고** 400 이다 —
// 클라이언트만 막으면 API 직접 호출이 우회한다.
func TestAPIGitIgnore_RejectsEscape(t *testing.T) {
	repo := t.TempDir()
	for _, p := range []string{"../outside.txt", "/etc/passwd", "src/../../x", ""} {
		f := newGitM5Fake(t)
		s := gitM5Server(t, f)
		code, out := gitReq(t, s, http.MethodPost, "/api/git/ignore",
			`{"repo":"`+repo+`","paths":["`+p+`"]}`)
		if code != http.StatusBadRequest || out["error"] != gitErrIgnorePath {
			t.Fatalf("%q: code = %d, out = %v", p, code, out)
		}
		if _, err := os.Stat(filepath.Join(repo, ".gitignore")); !os.IsNotExist(err) {
			t.Fatalf("%q 로 .gitignore 가 만들어졌다: %v", p, err)
		}
		if len(f.wrote()) != 0 {
			t.Fatalf("git 이 실행됐다: %v", f.wrote())
		}
	}
}

// F2 (V200): 중복 줄을 더하지 않는다. 두 번 넣어도 파일은 한 줄이며, 두 번째
// 응답의 added 는 비고 skipped 가 그 사실을 말한다.
func TestAPIGitIgnore_NoDuplicate(t *testing.T) {
	repo := t.TempDir()
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)
	body := `{"repo":"` + repo + `","paths":["a.txt"]}`

	code, out := gitReq(t, s, http.MethodPost, "/api/git/ignore", body)
	if code != http.StatusOK || out["ok"] != true {
		t.Fatalf("code = %d, out = %v", code, out)
	}
	if added, _ := out["added"].([]any); len(added) != 1 || added[0] != "/a.txt" {
		t.Fatalf("added = %v", out["added"])
	}

	code, out = gitReq(t, s, http.MethodPost, "/api/git/ignore", body)
	if code != http.StatusOK {
		t.Fatalf("code = %d, out = %v", code, out)
	}
	if added, _ := out["added"].([]any); len(added) != 0 {
		t.Fatalf("added = %v, want []", out["added"])
	}
	if skipped, _ := out["skipped"].([]any); len(skipped) != 1 || skipped[0] != "/a.txt" {
		t.Fatalf("skipped = %v", out["skipped"])
	}
	b, err := os.ReadFile(filepath.Join(repo, ".gitignore"))
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(b) != "/a.txt\n" {
		t.Fatalf("본문 = %q", b)
	}
	// **git 을 실행하지 않는다** (FR-GIT-273) — 파일 쓰기이지 git 동작이 아니다.
	for _, argv := range f.wrote() {
		if argv[0] != "status" {
			t.Fatalf("git 이 실행됐다: %v", f.wrote())
		}
	}
}

// F3 (V203): Clean 은 `confirm:true` 없이 실행되지 않는다.
func TestAPIGitUncommittedClean_RequiresConfirm(t *testing.T) {
	f := newGitM5Fake(t)
	f.status = gitIgnoreStatus("u.txt")
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/uncommitted/clean",
		`{"repo":"`+gitM5Repo+`"}`)
	if code != http.StatusBadRequest || out["error"] != gitErrConfirmRequired {
		t.Fatalf("code = %d, out = %v", code, out)
	}
	if len(f.wrote()) != 0 {
		t.Fatalf("확인 없이 실행됐다: %v", f.wrote())
	}
}

// F4 (V203): Clean 은 `clean -q -f -d` 를 한 번 실행한다. `-x` 는 붙지 않는다 —
// `.gitignore` 가 무시하는 것까지 지우는 것은 다른 뜻이다.
func TestAPIGitUncommittedClean(t *testing.T) {
	f := newGitM5Fake(t)
	f.status = gitIgnoreStatus("u.txt")
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/uncommitted/clean",
		`{"repo":"`+gitM5Repo+`","confirm":true}`)
	if code != http.StatusOK || out["ok"] != true {
		t.Fatalf("code = %d, out = %v", code, out)
	}
	w := f.wrote()
	if len(w) != 1 || strings.Join(w[0], " ") != "clean -q -f -d" {
		t.Fatalf("argv = %v", w)
	}
}

// F5 (V203): 지울 것이 없으면 실행하지 않는다 — git 은 그 실행을 exit 0 으로
// 끝내므로 성공으로 답하면 사용자는 지워진 것이 있다고 읽는다.
func TestAPIGitUncommittedClean_NothingToClean(t *testing.T) {
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/uncommitted/clean",
		`{"repo":"`+gitM5Repo+`","confirm":true}`)
	if code != http.StatusConflict || out["error"] != gitErrNothingToClean {
		t.Fatalf("code = %d, out = %v", code, out)
	}
	if len(f.wrote()) != 0 {
		t.Fatalf("실행됐다: %v", f.wrote())
	}
}

// F6 (V203): Reset 은 mixed 이고 확인을 요구하지 않는다 — 워킹 트리를 잃지 않는다.
func TestAPIGitUncommittedReset(t *testing.T) {
	f := newGitM5Fake(t)
	// fake 의 `rev-parse --verify` 는 branches 로 답한다 — HEAD 가 커밋을 가리키는
	// 저장소를 세운다 (write.UncommittedReset 이 실행 전에 그것을 본다).
	f.branches["HEAD"] = true
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/uncommitted/reset",
		`{"repo":"`+gitM5Repo+`"}`)
	if code != http.StatusOK || out["ok"] != true {
		t.Fatalf("code = %d, out = %v", code, out)
	}
	w := f.wrote()
	if len(w) != 1 || strings.Join(w[0], " ") != "reset -q --mixed HEAD" {
		t.Fatalf("argv = %v", w)
	}
}

// F7 (V203): 커밋이 없으면 Reset 을 실행하지 않는다.
func TestAPIGitUncommittedReset_NoHead(t *testing.T) {
	f := newGitM5Fake(t)
	f.status = gitInitialStatus()
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/uncommitted/reset",
		`{"repo":"`+gitM5Repo+`"}`)
	if code != http.StatusConflict || out["error"] != gitErrNoHead {
		t.Fatalf("code = %d, out = %v", code, out)
	}
	if len(f.wrote()) != 0 {
		t.Fatalf("실행됐다: %v", f.wrote())
	}
}

// F8 (V199): Branch from stash 는 `stash branch <name> <stash>` 를 실행한다.
func TestAPIGitStashBranch(t *testing.T) {
	f := newGitM5Fake(t)
	f.stashes = gitStashTwo
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/stash/branch",
		`{"repo":"`+gitM5Repo+`","index":1,"name":"feat/from-stash"}`)
	if code != http.StatusOK || out["ok"] != true {
		t.Fatalf("code = %d, out = %v", code, out)
	}
	w := f.wrote()
	if len(w) != 1 || strings.Join(w[0], " ") != "stash branch feat/from-stash stash@{1}" {
		t.Fatalf("argv = %v", w)
	}
}

// F9 (FR-GIT-250.3): 이름·인덱스는 실행 **전에** 본다. 클라이언트만 막으면 API
// 직접 호출이 우회한다.
func TestAPIGitStashBranch_Rejects(t *testing.T) {
	cases := []string{
		`{"repo":"` + gitM5Repo + `","index":0,"name":""}`,
		`{"repo":"` + gitM5Repo + `","index":0,"name":"--force"}`,
		`{"repo":"` + gitM5Repo + `","index":-1,"name":"ok"}`,
		`{"repo":"` + gitM5Repo + `","index":0,"name":"bad name"}`,
	}
	for _, body := range cases {
		f := newGitM5Fake(t)
		f.stashes = gitStashTwo
		s := gitM5Server(t, f)
		code, out := gitReq(t, s, http.MethodPost, "/api/git/stash/branch", body)
		if code != http.StatusBadRequest {
			t.Fatalf("%s: code = %d, out = %v", body, code, out)
		}
		if len(f.wrote()) != 0 {
			t.Fatalf("%s: 실행됐다 %v", body, f.wrote())
		}
	}
}

// F10 (V199): 없는 인덱스는 404 이며 실행하지 않는다.
func TestAPIGitStashBranch_MissingIndex(t *testing.T) {
	f := newGitM5Fake(t)
	f.stashes = gitStashTwo
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/stash/branch",
		`{"repo":"`+gitM5Repo+`","index":9,"name":"feat"}`)
	if code != http.StatusNotFound || out["error"] != gitErrNotFound {
		t.Fatalf("code = %d, out = %v", code, out)
	}
	if len(f.wrote()) != 0 {
		t.Fatalf("실행됐다: %v", f.wrote())
	}
}

// F11: 라우트가 표에 등록돼 있어야 한다 — UI 는 이 표면 위에만 선다 (FR-GIT-61).
func TestBundleFRoutesRegistered(t *testing.T) {
	want := []struct{ method, path string }{
		{http.MethodPost, "/api/git/stash/branch"},
		{http.MethodPost, "/api/git/ignore"},
		{http.MethodGet, "/api/git/file-head"},
		{http.MethodPost, "/api/git/uncommitted/reset"},
		{http.MethodPost, "/api/git/uncommitted/clean"},
	}
	for _, w := range want {
		found := false
		for _, rt := range routes {
			if rt.method == w.method && rt.match(w.path) {
				found = true
			}
		}
		if !found {
			t.Fatalf("%s %s 라우트가 없다", w.method, w.path)
		}
	}
}
