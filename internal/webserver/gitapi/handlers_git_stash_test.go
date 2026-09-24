package gitapi

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"net/url"
)

// 묶음 O 서버측 — /api/git/stash{,/push,/apply,/pop,/drop,/show}
// (GIT_SRS §3D.2, 검증 V56·V57·V58).
//
// **서버가 마지막 방어선이다.** drop 의 확인과 "담을 것이 없다" 를 클라이언트만
// 막으면 API 직접 호출이 그대로 우회한다.

// gitStashOut 은 stash list 의 stdout 이다. 꼬리 NUL + 개행까지 그대로 만든다 —
// 파서가 실제 출력과 같은 것을 보게 해야 한다.
func gitStashOut(recs ...[4]string) string {
	var b strings.Builder
	for _, r := range recs {
		b.WriteString(strings.Join(r[:], "\x00") + "\x00\n")
	}
	return b.String()
}

var (
	gitStashA = strings.Repeat("a", 40)
	gitStashB = strings.Repeat("b", 40)
)

var gitStashTwo = gitStashOut(
	[4]string{"stash@{0}", strings.Repeat("a", 40), "On main: 나중 것", "1700000060"},
	[4]string{"stash@{1}", strings.Repeat("b", 40), "WIP on main: abc123 첫 것", "1700000000"},
)

// N1 (V56, FR-GIT-161): 목록은 인덱스·oid·메시지·기준·시각을 준다.
func TestAPIGitStashList(t *testing.T) {
	f := newGitM5Fake(t)
	f.stashes = gitStashTwo
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/stash?repo="+url.QueryEscape(absWorkRepo), "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	list, _ := out["stashes"].([]any)
	if len(list) != 2 {
		t.Fatalf("stashes = %v", out["stashes"])
	}
	first, _ := list[0].(map[string]any)
	if first["index"] != float64(0) || first["message"] != "나중 것" || first["base"] != "main" {
		t.Fatalf("stash[0] = %v", first)
	}
	if first["atUnixMs"] != float64(1700000060000) {
		t.Fatalf("atUnixMs = %v", first["atUnixMs"])
	}
	req, _ := out["requested"].(map[string]any)
	if req["repo"] != gitM5Repo {
		t.Fatalf("requested = %v", req)
	}
}

// N2 (V58, FR-GIT-166·170): 생성 옵션이 argv 로 가고, 응답에 **조작 후 목록과
// 상태**가 함께 온다 — 폴링 주기를 기다리면 화면이 그만큼 거짓말을 한다.
func TestAPIGitStashPush(t *testing.T) {
	f := newGitM5Fake(t)
	f.onWrite = func(f *gitM5Fake, _ []string) {
		f.status = gitWriteStatus("b.txt", ".M")
		f.stashes = gitStashTwo
	}
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/stash/push",
		`{"repo":`+qWorkRepo+`,"message":"작업 중","includeUntracked":true,"keepIndex":true}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	want := []string{"stash", "push", "--include-untracked", "--keep-index", "--message=작업 중"}
	if got := f.wrote(); len(got) != 1 || fmt.Sprint(got[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
	if list, _ := out["stashes"].([]any); len(list) != 2 {
		t.Fatalf("조작 후 목록이 없다: %v", out["stashes"])
	}
	if st, _ := out["status"].(map[string]any); st == nil {
		t.Fatalf("조작 후 상태가 없다: %v", out)
	}
}

// N3 (V58, FR-GIT-167): 담을 것이 없으면 **실행하지 않고** 사유를 준다.
//
// untracked 만 있고 `--include-untracked` 가 없는 경우도 같다 — git 은 그 실행을
// exit 0 으로 끝내므로 성공으로 답하면 사용자는 만들어지지 않은 stash 를 찾는다.
func TestAPIGitStashPush_NothingToStash(t *testing.T) {
	cases := []struct {
		name   string
		status string
		body   string
	}{
		{"변경 없음", gitCleanStatus(), `{"repo":` + qWorkRepo + `}`},
		{"untracked 만 + -u 없음", gitUntrackedStatus(), `{"repo":` + qWorkRepo + `}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newGitM5Fake(t)
			f.status = c.status
			s := gitM5Server(t, f)

			code, out := gitReq(t, s, http.MethodPost, "/api/git/stash/push", c.body)
			if code != http.StatusConflict || out["error"] != gitErrNothingToStash {
				t.Fatalf("code = %d, error = %v, want 409 nothing_to_stash", code, out["error"])
			}
			if out["message"] == "" {
				t.Fatal("사유가 비었다 — 사용자가 무엇을 해소해야 하는지 알 수 없다")
			}
			if got := f.wrote(); len(got) != 0 {
				t.Fatalf("거부됐는데 실행됐다: %v", got)
			}
		})
	}

	// `-u` 를 켜면 untracked 만 있어도 담긴다.
	f := newGitM5Fake(t)
	f.status = gitUntrackedStatus()
	s := gitM5Server(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/stash/push",
		`{"repo":`+qWorkRepo+`,"includeUntracked":true}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
}

// N4 (V56, FR-GIT-163·164): apply/pop 의 argv. `--index` 는 요청이 고를 때만 붙는다.
func TestAPIGitStashApplyPop_Args(t *testing.T) {
	cases := []struct {
		path string
		body string
		want []string
	}{
		// REPO_FIX 01 §5.3: oid 로 지목한다. apply 는 oid 그대로, pop 은 현재 위치.
		{"/api/git/stash/apply", `{"repo":` + qWorkRepo + `,"oid":"` + gitStashB + `"}`, []string{"stash", "apply", gitStashB}},
		{"/api/git/stash/apply", `{"repo":` + qWorkRepo + `,"oid":"` + gitStashA + `","withIndex":true}`, []string{"stash", "apply", "--index", gitStashA}},
		{"/api/git/stash/pop", `{"repo":` + qWorkRepo + `,"oid":"` + gitStashB + `"}`, []string{"stash", "pop", "stash@{1}"}},
	}
	for _, c := range cases {
		t.Run(fmt.Sprint(c.want), func(t *testing.T) {
			f := newGitM5Fake(t)
			f.stashes = gitStashTwo
			// pop 이 성공한 것으로 만든다 — 목록에서 그 인덱스가 사라진다.
			f.onWrite = func(f *gitM5Fake, argv []string) {
				if argv[1] == "pop" {
					f.stashes = gitStashOut([4]string{"stash@{0}", strings.Repeat("a", 40), "On main: 나중 것", "1700000060"})
				}
			}
			s := gitM5Server(t, f)

			code, out := gitReq(t, s, http.MethodPost, c.path, c.body)
			if code != http.StatusOK {
				t.Fatalf("code = %d, body = %v", code, out)
			}
			if got := f.wrote(); len(got) != 1 || fmt.Sprint(got[0]) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", got, c.want)
			}
			if c.want[1] == "pop" && out["stashKept"] != false {
				t.Fatalf("stashKept = %v, want false", out["stashKept"])
			}
		})
	}
}

// N5 (V57, FR-GIT-165): **pop 이 충돌로 끝나면 stash 가 남고, 그 사실이 응답에
// 있어야 한다.** 조용히 넘기면 사용자는 작업을 잃었다고 오해한다.
func TestAPIGitStashPop_ConflictKeepsStash(t *testing.T) {
	f := newGitM5Fake(t)
	f.stashes = gitStashTwo
	// git 은 충돌로 끝나면 exit 1 이고 stash 를 지우지 않는다 — 목록을 그대로 둔다.
	f.writeErr = func(argv []string) (core.Output, error) {
		if argv[1] == "pop" {
			return core.Output{ExitCode: 1, Stderr: "CONFLICT (content): Merge conflict in a.txt\n"}, nil
		}
		return core.Output{}, nil
	}
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/stash/pop", `{"repo":`+qWorkRepo+`,"oid":"`+gitStashB+`"}`)
	if code != http.StatusConflict || out["error"] != gitErrStashKept {
		t.Fatalf("code = %d, error = %v, want 409 stash_kept", code, out["error"])
	}
	if out["stashKept"] != true {
		t.Fatalf("stashKept = %v, want true", out["stashKept"])
	}
	if out["stashKeptOid"] != strings.Repeat("b", 40) {
		t.Fatalf("stashKeptOid = %v", out["stashKeptOid"])
	}
	reason, _ := out["stashKeptReason"].(string)
	if reason == "" {
		t.Fatal("사유가 비었다 — 무엇이 남았는지 사용자가 알 수 없다")
	}
	// 남은 목록도 함께 온다 (FR-GIT-170) — 실패 응답이라고 목록을 빼면 화면이
	// 낡은 값을 유지한다.
	if list, _ := out["stashes"].([]any); len(list) != 2 {
		t.Fatalf("stashes = %v", out["stashes"])
	}
}

// N6 (V58, FR-GIT-168): drop 은 `confirm:true` 없이 400 이며 **실행되지 않는다.**
func TestAPIGitStashDrop_RequiresConfirm(t *testing.T) {
	f := newGitM5Fake(t)
	f.stashes = gitStashTwo
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/stash/drop", `{"repo":`+qWorkRepo+`,"oid":"`+gitStashA+`"}`)
	if code != http.StatusBadRequest || out["error"] != gitErrConfirmRequired {
		t.Fatalf("code = %d, error = %v, want 400 confirmation_required", code, out["error"])
	}
	if got := f.wrote(); len(got) != 0 {
		t.Fatalf("거부됐는데 실행됐다: %v", got)
	}
}

// N7 (V58, FR-GIT-168·92): drop 은 실행 **전에** sha·메시지·시각을 recovery hint 에
// 남긴다. 안내문만으로는 지워진 stash 를 되살릴 수 없다.
func TestAPIGitStashDrop_RecordsHint(t *testing.T) {
	f := newGitM5Fake(t)
	f.stashes = gitStashTwo
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodPost, "/api/git/stash/drop",
		`{"repo":`+qWorkRepo+`,"oid":"`+gitStashB+`","confirm":true}`)
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	want := []string{"stash", "drop", "stash@{1}"}
	if got := f.wrote(); len(got) != 1 || fmt.Sprint(got[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}

	_, rec := gitReq(t, s, http.MethodGet, "/api/git/recovery", "")
	hints, _ := rec["hints"].([]any)
	if len(hints) != 1 {
		t.Fatalf("hints = %v", rec["hints"])
	}
	h, _ := hints[0].(map[string]any)
	if h["action"] != core.ActionStashDrop {
		t.Fatalf("action = %v", h["action"])
	}
	vals, _ := h["values"].([]any)
	if len(vals) != 1 || vals[0] != strings.Repeat("b", 40) {
		t.Fatalf("values = %v", h["values"])
	}
	cmd, _ := h["command"].(string)
	if !strings.HasPrefix(cmd, "git stash store ") || !strings.Contains(cmd, strings.Repeat("b", 40)) {
		t.Fatalf("command = %q", cmd)
	}
}

// N8 (FR-GIT-169): 미리보기는 변경 파일 목록이다. rename 은 `-z` 에서 세 조각이며
// 커밋 상세와 같은 파서를 쓴다.
func TestAPIGitStashShow(t *testing.T) {
	f := newGitM5Fake(t)
	f.stashes = gitStashTwo
	f.show = "R094\x00old.txt\x00new.txt\x00"
	s := gitM5Server(t, f)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/stash/show?repo="+url.QueryEscape(absWorkRepo)+"&oid="+gitStashB, "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	files, _ := out["files"].([]any)
	if len(files) != 1 {
		t.Fatalf("files = %v", out["files"])
	}
	fl, _ := files[0].(map[string]any)
	if fl["status"] != "R" || fl["origPath"] != "old.txt" || fl["path"] != "new.txt" {
		t.Fatalf("file = %v", fl)
	}
	req, _ := out["requested"].(map[string]any)
	if req["repo"] != gitM5Repo || req["oid"] != gitStashB {
		t.Fatalf("requested = %v", req)
	}
	if got := f.wrote(); len(got) != 0 {
		t.Fatalf("미리보기가 쓰기로 기록됐다: %v", got)
	}
}

// §5.3: index 는 더 이상 받지 않는다(400, 실행 없음). oid 형식이 아니면 400.
func TestAPIGitStash_IndexAndBadOidRejected(t *testing.T) {
	bodies := []string{
		`{"repo":` + qWorkRepo + `,"index":0}`,
		`{"repo":` + qWorkRepo + `,"oid":"` + gitStashA + `","index":0}`,
		`{"repo":` + qWorkRepo + `,"oid":"stash@{0}"}`,
		`{"repo":` + qWorkRepo + `}`,
	}
	for _, path := range []string{"/api/git/stash/apply", "/api/git/stash/pop"} {
		for _, body := range bodies {
			f := newGitM5Fake(t)
			f.stashes = gitStashTwo
			s := gitM5Server(t, f)
			code, out := gitReq(t, s, http.MethodPost, path, body)
			if code != http.StatusBadRequest || out["error"] != gitErrBadRequest {
				t.Fatalf("%s %s → %d %v, want 400 bad_request", path, body, code, out["error"])
			}
			if got := f.wrote(); len(got) != 0 {
				t.Fatalf("%s: 거부됐는데 실행됐다: %v", path, got)
			}
		}
	}
	f := newGitM5Fake(t)
	s := gitM5Server(t, f)
	for _, q := range []string{"&index=0", "&oid=bad"} {
		code, out := gitReq(t, s, http.MethodGet, "/api/git/stash/show?repo="+url.QueryEscape(absWorkRepo)+q, "")
		if code != http.StatusBadRequest {
			t.Fatalf("show %s → %d %v, want 400", q, code, out["error"])
		}
	}
}

// §5.3: 목록에 없는 oid 는 409 stash_moved 이며 실행되지 않는다. 본문에 현재 목록이
// 실려 화면이 다시 묻지 않아도 된다.
func TestAPIGitStashDrop_MovedOid(t *testing.T) {
	f := newGitM5Fake(t)
	f.stashes = gitStashTwo
	s := gitM5Server(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/stash/drop",
		`{"repo":`+qWorkRepo+`,"oid":"`+strings.Repeat("d", 40)+`","confirm":true}`)
	if code != http.StatusConflict || out["error"] != "stash_moved" {
		t.Fatalf("code = %d, error = %v, want 409 stash_moved", code, out["error"])
	}
	if list, _ := out["stashes"].([]any); len(list) != 2 {
		t.Fatalf("stashes = %v", out["stashes"])
	}
	if got := f.wrote(); len(got) != 0 {
		t.Fatalf("거부됐는데 실행됐다: %v", got)
	}
}

// §5.3: 미리보기에서도 사라진 oid 는 409 stash_moved + 현재 목록이다.
func TestAPIGitStashShow_MovedOid(t *testing.T) {
	f := newGitM5Fake(t)
	f.stashes = gitStashTwo
	s := gitM5Server(t, f)
	code, out := gitReq(t, s, http.MethodGet, "/api/git/stash/show?repo="+url.QueryEscape(absWorkRepo)+"&oid="+strings.Repeat("d", 40), "")
	if code != http.StatusConflict || out["error"] != "stash_moved" {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	if list, _ := out["stashes"].([]any); len(list) != 2 {
		t.Fatalf("stashes = %v", out["stashes"])
	}
}

// gitCleanStatus 는 변경이 없는 porcelain v2 출력이다.
func gitCleanStatus() string {
	return strings.Join([]string{
		"# branch.oid " + strings.Repeat("a", 40),
		"# branch.head main",
	}, "\x00") + "\x00"
}

// gitUntrackedStatus 는 untracked 하나만 있는 출력이다 — FR-GIT-167 의 경계다.
func gitUntrackedStatus() string {
	return gitCleanStatus() + "? n.txt\x00"
}
