package server

import (
	"context"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/git"
)

// 묶음 L·M 서버측 — /api/git/log·/commit·/refs (GIT_SRS §3C FR-GIT-113~114·122~123·
// 128·130·133·136~139·145, 검증 V45).

// gitHistFake 은 하위 명령별 stdout 을 답하며 argv 를 기록한다. 리포 루트는
// requested 와 다른 값으로 답한다 — 응답의 repo 와 requested.repo 가 섞이지 않는지
// 봐야 한다.
type gitHistFake struct {
	root    string
	gitDir  string
	logOut  string
	treeOut string
	refsOut string
	argvs   [][]string
}

func newGitHistFake(t *testing.T) *gitHistFake {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &gitHistFake{root: root, gitDir: t.TempDir()}
}

func (f *gitHistFake) runner(_ context.Context, _ string, args []string) (git.Output, error) {
	switch {
	case args[0] == "rev-parse" && len(args) > 1 && args[1] == "--show-toplevel":
		return git.Output{Stdout: f.root + "\n"}, nil
	case args[0] == "rev-parse":
		return git.Output{Stdout: f.gitDir + "\n" + f.gitDir + "\n"}, nil
	}
	f.argvs = append(f.argvs, append([]string(nil), args...))
	switch args[0] {
	case "log":
		return git.Output{Stdout: f.logOut}, nil
	case "diff-tree":
		return git.Output{Stdout: f.treeOut}, nil
	case "for-each-ref":
		return git.Output{Stdout: f.refsOut}, nil
	}
	return git.Output{ExitCode: 128, Stderr: "fatal: 예상하지 못한 호출\n"}, nil
}

func (f *gitHistFake) calls() []string {
	out := make([]string, 0, len(f.argvs))
	for _, a := range f.argvs {
		out = append(out, strings.Join(a, " "))
	}
	return out
}

func gitHistServer(t *testing.T, f *gitHistFake) *Server {
	t.Helper()
	store := git.NewStore(git.New(git.WithRunner(f.runner)))
	return &Server{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore(), Commands: &fakeCommandBroker{}, Git: store}
}

// histLogRec 은 log -z 레코드 하나다 (9 필드, 레코드 사이에만 NUL).
func histLogRec(oid, parents, dec, subject string) string {
	return strings.Join([]string{oid, oid[:4], parents, "김 동민", "dy@example.com",
		"1700000000", "1700000060", dec, subject}, "\x00")
}

// histDetailRec 은 상세 레코드 하나다 (12 필드).
func histDetailRec(oid, parents, dec, subject, body string) string {
	return strings.Join([]string{oid, oid[:4], parents, "김 동민", "dy@example.com",
		"1700000000", "1700000060", dec, subject, "커미터", "c@example.com", body}, "\x00")
}

const histOid = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0"

// 새 라우트 3개가 apiRoutes 에 등록돼 있고, Git 이 없으면 503 이다 (기존 규약).
var gitHistoryEndpoints = []struct {
	method string
	path   string
}{
	{http.MethodGet, "/api/git/log?repo=/r"},
	{http.MethodGet, "/api/git/commit?repo=/r&oid=" + histOid},
	{http.MethodGet, "/api/git/refs?repo=/r"},
}

func TestGitHistoryRoutesRegistered(t *testing.T) {
	for _, ep := range gitHistoryEndpoints {
		path := strings.SplitN(ep.path, "?", 2)[0]
		found := false
		for _, rt := range apiRoutes {
			if rt.method != "" && rt.method != ep.method {
				continue
			}
			if rt.match(path) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s %s 가 apiRoutes 에 없다", ep.method, path)
		}
	}
}

func TestGitHistoryEndpoints_Unavailable(t *testing.T) {
	s := &Server{Tools: newFakePaneHub(), Work: newFakeWorkspaceStore()}
	for _, ep := range gitHistoryEndpoints {
		code, out := gitReq(t, s, ep.method, ep.path, "")
		if code != http.StatusServiceUnavailable {
			t.Errorf("%s %s → %d, want 503", ep.method, ep.path, code)
		}
		if out["error"] != gitErrUnavailable {
			t.Errorf("%s %s error=%v", ep.method, ep.path, out["error"])
		}
	}
}

// H-L1 (FR-GIT-133·145): /log 은 (repo, ref, skip, limit, order, 필터) 를 그대로
// 되돌린다 — stale 가드의 서버측 절반이며, 해석된 루트가 그 자리를 대신하면
// 클라이언트는 응답과 자기 요청의 짝을 맞출 수 없다.
func TestAPIGitLog_EchoesRequested(t *testing.T) {
	f := newGitHistFake(t)
	f.logOut = strings.Join([]string{
		histLogRec(histOid, "b1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0", "HEAD -> refs/heads/main, tag: refs/tags/v1.0", "머지 · 제목"),
		histLogRec("b1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0", "", "", "root"),
	}, "\x00")
	s := gitHistServer(t, f)

	sub := filepath.Join(f.root, "sub")
	code, out := gitReq(t, s, http.MethodGet,
		"/api/git/log?repo="+sub+"&ref=refs/heads/main&skip=300&limit=100&order=topo"+
			"&author=%EA%B9%80&since=2024-01-01&until=2024-02-01&path=d+ir%2Fa.txt&grep=fix", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	req, ok := out["requested"].(map[string]any)
	if !ok {
		t.Fatalf("requested 가 없다: %v", out)
	}
	want := map[string]any{
		"repo": sub, "ref": "refs/heads/main", "skip": float64(300), "limit": float64(100),
		"order": "topo", "author": "김", "since": "2024-01-01", "until": "2024-02-01",
		"path": "d ir/a.txt", "grep": "fix",
	}
	for k, v := range want {
		if req[k] != v {
			t.Fatalf("requested[%q] = %#v, want %#v", k, req[k], v)
		}
	}
	// 해석된 루트는 별도 필드다.
	if out["repo"] != f.root {
		t.Fatalf("repo = %v, want %v", out["repo"], f.root)
	}
	commits, ok := out["commits"].([]any)
	if !ok || len(commits) != 2 {
		t.Fatalf("commits = %#v", out["commits"])
	}
	// 그래프의 입력은 oid·parents 다 (FR-GIT-117).
	c0, _ := commits[0].(map[string]any)
	if c0["oid"] != histOid {
		t.Fatalf("commits[0].oid = %v", c0["oid"])
	}
	ps, ok := c0["parents"].([]any)
	if !ok || len(ps) != 1 {
		t.Fatalf("parents = %#v", c0["parents"])
	}
	// 루트 커밋의 parents 는 null 이 아니라 [] 여야 레인 계산이 돈다.
	c1, _ := commits[1].(map[string]any)
	if ps1, ok := c1["parents"].([]any); !ok || len(ps1) != 0 {
		t.Fatalf("root parents = %#v", c1["parents"])
	}
	// 배지는 종류와 HEAD 여부를 갖는다 (FR-GIT-126).
	if c0["isHead"] != true {
		t.Fatalf("isHead = %v", c0["isHead"])
	}
	refs, ok := c0["refs"].([]any)
	if !ok || len(refs) != 2 {
		t.Fatalf("refs = %#v", c0["refs"])
	}
	r0, _ := refs[0].(map[string]any)
	if r0["name"] != "main" || r0["kind"] != "local" || r0["isHead"] != true {
		t.Fatalf("refs[0] = %#v", r0)
	}
	r1, _ := refs[1].(map[string]any)
	if r1["name"] != "v1.0" || r1["kind"] != "tag" {
		t.Fatalf("refs[1] = %#v", r1)
	}
}

// 실제로 쓰인 개수를 알려야 한다 — 상한으로 접힌 것을 알리지 않으면 클라이언트는
// 자기가 요청한 만큼 받았다고 믿고 페이징을 어긋나게 계산한다.
func TestAPIGitLog_ReportsEffectiveLimit(t *testing.T) {
	f := newGitHistFake(t)
	s := gitHistServer(t, f)
	for _, tc := range []struct {
		query string
		want  float64
	}{
		{"", float64(git.LogInitialLimit)},
		{"&limit=100", 100},
		{"&limit=999999", float64(git.LogMaxLimit)},
	} {
		code, out := gitReq(t, s, http.MethodGet, "/api/git/log?repo="+f.root+tc.query, "")
		if code != http.StatusOK {
			t.Fatalf("code = %d, body = %v", code, out)
		}
		if out["limit"] != tc.want {
			t.Fatalf("limit%q = %v, want %v", tc.query, out["limit"], tc.want)
		}
	}
	// 커밋이 없으면 null 이 아니라 빈 배열이다.
	_, out := gitReq(t, s, http.MethodGet, "/api/git/log?repo="+f.root, "")
	if cs, ok := out["commits"].([]any); !ok || len(cs) != 0 {
		t.Fatalf("commits = %#v", out["commits"])
	}
}

// H-L2 (FR-GIT-128): 모르는 정렬값은 400 이다. 조용히 기본값으로 낮추면 사용자는
// 자기가 고른 순서로 보고 있다고 믿는다.
func TestAPIGitLog_RejectsBadParams(t *testing.T) {
	f := newGitHistFake(t)
	s := gitHistServer(t, f)
	for _, q := range []string{
		"&order=reverse",
		"&skip=abc",
		"&limit=abc",
		"&skip=-1",
		"&ref=--all",
	} {
		code, out := gitReq(t, s, http.MethodGet, "/api/git/log?repo="+f.root+q, "")
		if code != http.StatusBadRequest {
			t.Fatalf("%q → %d, want 400 (body %v)", q, code, out)
		}
		if out["error"] != gitErrBadRequest {
			t.Fatalf("%q error = %v", q, out["error"])
		}
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부했는데 실행했다: %v", f.calls())
	}
}

// H-M1 (FR-GIT-145): /commit 은 (repo, oid, parent) 를 되돌린다.
func TestAPIGitCommit_EchoesRequested(t *testing.T) {
	f := newGitHistFake(t)
	f.logOut = histDetailRec(histOid, "p1 p2", "", "머지 제목", "머지 제목\n\n본문\n")
	f.treeOut = "R100\x00old name.txt\x00d ir/한글 파일.txt\x00"
	s := gitHistServer(t, f)

	sub := filepath.Join(f.root, "sub")
	code, out := gitReq(t, s, http.MethodGet, "/api/git/commit?repo="+sub+"&oid="+histOid+"&parent=1", "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	req, ok := out["requested"].(map[string]any)
	if !ok {
		t.Fatalf("requested 가 없다: %v", out)
	}
	for k, v := range map[string]any{"repo": sub, "oid": histOid, "parent": float64(1)} {
		if req[k] != v {
			t.Fatalf("requested[%q] = %#v, want %#v", k, req[k], v)
		}
	}
	if out["repo"] != f.root {
		t.Fatalf("repo = %v", out["repo"])
	}
	if out["parentIndex"] != float64(1) {
		t.Fatalf("parentIndex = %v", out["parentIndex"])
	}
	if out["committerName"] != "커미터" || out["body"] != "머지 제목\n\n본문\n" {
		t.Fatalf("상세 = %v", out)
	}
	files, ok := out["files"].([]any)
	if !ok || len(files) != 1 {
		t.Fatalf("files = %#v", out["files"])
	}
	f0, _ := files[0].(map[string]any)
	if f0["status"] != "R" || f0["path"] != "d ir/한글 파일.txt" || f0["origPath"] != "old name.txt" {
		t.Fatalf("files[0] = %#v", f0)
	}
	// 머지 커밋은 지정한 부모와 비교한다 (FR-GIT-139).
	if got := f.calls(); len(got) != 2 || !strings.HasSuffix(got[1], histOid+"^2 "+histOid) {
		t.Fatalf("argv = %v", got)
	}
}

// oid 가 없거나 부모 번호가 범위를 벗어나면 400 이다. 없는 커밋은 404 다 —
// 저장소가 아닌 것(not_a_git_repo)과 구분되어야 한다.
func TestAPIGitCommit_RejectsBadParams(t *testing.T) {
	f := newGitHistFake(t)
	f.logOut = histDetailRec(histOid, "p1", "", "s", "s\n")
	s := gitHistServer(t, f)
	for _, tc := range []struct {
		query string
		code  int
		name  string
	}{
		{"", http.StatusBadRequest, gitErrBadRequest},
		{"&oid=" + histOid + "&parent=abc", http.StatusBadRequest, gitErrBadRequest},
		{"&oid=" + histOid + "&parent=1", http.StatusBadRequest, gitErrBadRequest},
		{"&oid=" + histOid + "&parent=-1", http.StatusBadRequest, gitErrBadRequest},
		{"&oid=--all", http.StatusBadRequest, gitErrBadRequest},
	} {
		code, out := gitReq(t, s, http.MethodGet, "/api/git/commit?repo="+f.root+tc.query, "")
		if code != tc.code || out["error"] != tc.name {
			t.Fatalf("%q → %d %v, want %d %q", tc.query, code, out["error"], tc.code, tc.name)
		}
	}
}

func TestAPIGitCommit_UnknownOidIsNotFound(t *testing.T) {
	f := newGitHistFake(t)
	f.logOut = "" // git 이 빈 결과를 주면 그 커밋이 없다는 뜻이다
	s := gitHistServer(t, f)
	code, out := gitReq(t, s, http.MethodGet, "/api/git/commit?repo="+f.root+"&oid="+histOid, "")
	if code != http.StatusNotFound || out["error"] != gitErrNotFound {
		t.Fatalf("code = %d, body = %v", code, out)
	}
}

// H-L3 (FR-GIT-122·145): /refs 는 (repo) 를 되돌리고 3그룹을 종류로 갈라 준다.
func TestAPIGitRefs_EchoesRequested(t *testing.T) {
	f := newGitHistFake(t)
	f.refsOut = strings.Join([]string{
		strings.Join([]string{"refs/heads/main", "aa", "origin/main", "[ahead 2, behind 1]", "*", "제목", "1700000000"}, "\x00"),
		strings.Join([]string{"refs/remotes/origin/main", "bb", "", "", " ", "제목", "1700000001"}, "\x00"),
		strings.Join([]string{"refs/tags/v1.0", "cc", "", "", " ", "제목", "1700000002"}, "\x00"),
	}, "\n") + "\n"
	s := gitHistServer(t, f)

	sub := filepath.Join(f.root, "sub")
	code, out := gitReq(t, s, http.MethodGet, "/api/git/refs?repo="+sub, "")
	if code != http.StatusOK {
		t.Fatalf("code = %d, body = %v", code, out)
	}
	req, ok := out["requested"].(map[string]any)
	if !ok || req["repo"] != sub {
		t.Fatalf("requested = %#v", out["requested"])
	}
	if out["repo"] != f.root {
		t.Fatalf("repo = %v", out["repo"])
	}
	refs, ok := out["refs"].([]any)
	if !ok || len(refs) != 3 {
		t.Fatalf("refs = %#v", out["refs"])
	}
	r0, _ := refs[0].(map[string]any)
	for k, v := range map[string]any{
		"name": "refs/heads/main", "short": "main", "kind": "local", "oid": "aa",
		"upstream": "origin/main", "ahead": float64(2), "behind": float64(1), "isHead": true,
		"atUnixMs": float64(1700000000000),
	} {
		if r0[k] != v {
			t.Fatalf("refs[0][%q] = %#v, want %#v", k, r0[k], v)
		}
	}
	r1, _ := refs[1].(map[string]any)
	r2, _ := refs[2].(map[string]any)
	if r1["kind"] != "remote" || r2["kind"] != "tag" {
		t.Fatalf("kind = %v / %v", r1["kind"], r2["kind"])
	}
	// ref 가 없으면 null 이 아니라 빈 배열이다.
	f.refsOut = ""
	_, out = gitReq(t, s, http.MethodGet, "/api/git/refs?repo="+f.root, "")
	if rs, ok := out["refs"].([]any); !ok || len(rs) != 0 {
		t.Fatalf("refs = %#v", out["refs"])
	}
}

// repo 인자 규약은 기존 엔드포인트와 같다 (FR-GIT-62).
func TestGitHistoryEndpoints_RepoParam(t *testing.T) {
	f := newGitHistFake(t)
	s := gitHistServer(t, f)
	for _, ep := range []string{"/api/git/log", "/api/git/refs", "/api/git/commit"} {
		for _, q := range []string{"", "?repo=relative/path"} {
			code, out := gitReq(t, s, http.MethodGet, ep+q, "")
			if code != http.StatusBadRequest || out["error"] != gitErrBadRequest {
				t.Fatalf("%s%s → %d %v", ep, q, code, out["error"])
			}
		}
	}
}
