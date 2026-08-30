package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/wsentry"

	"dongminal/internal/shared/testpath"
)

// /api/fs/* · /api/editors/* 서버측 (EDITOR_TAB_SRS §3.11, V-EDT-8·10·45·65~67·82~84).

// fsTestServer 는 홈을 tempdir 로 옮긴 Server 를 세운다. root 에디터의 경로는
// 서버의 홈에서 파생되므로(FR-EDT-17) 홈을 고정하지 않으면 테스트가 실행 환경에
// 달린다.
func fsTestServer(t *testing.T) (*Server, *fakeWorkspaceStore, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv(testpath.HomeEnv(), home)
	ws := newFakeWorkspaceStore()
	srv, err := New(Config{Port: "0", DataDir: t.TempDir()}, Deps{Work: ws, Commands: &fakeCommandBroker{}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return srv, ws, wsentry.NormalizePath(home)
}

func fsReq(t *testing.T, s *Server, method, path, body string) (int, map[string]any) {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	rec := httptest.NewRecorder()
	http.HandlerFunc(s.handleAPI).ServeHTTP(rec, r)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

// seedRoot 는 root 를 editors.list 에 심는다 — 서버는 클라이언트가 보낸 root 를
// 신뢰하지 않는다 (FR-EDT-113).
func seedRoot(t *testing.T, ws *fakeWorkspaceStore, root string) {
	t.Helper()
	ws.raw = []byte(fmt.Sprintf(`{"schemaVersion":2,"editors":{"list":[%q]}}`, root))
}

func entryNames(t *testing.T, out map[string]any) []string {
	t.Helper()
	arr, ok := out["entries"].([]any)
	if !ok {
		t.Fatalf("entries 가 없다: %v", out)
	}
	names := make([]string, 0, len(arr))
	for _, v := range arr {
		e, _ := v.(map[string]any)
		names = append(names, fmt.Sprint(e["name"]))
	}
	return names
}

// V-EDT-82 (FR-EDT-108): dot 항목을 포함해 돌려준다. 숨김 규칙도 필터도 없다.
// FR-EDT-58: 점 둘로 시작하는 이름은 정상 파일명이다. 경계 검사가 문자열
// 접두로 판정하면(`safeResolve` 가 그렇다) 이것들이 루트 밖으로 오인된다.
// FR-EDT-114: 중첩된 Editor 행이 있을 때 바깥 루트로 안쪽 루트를 지울 수 없다.
// 지워지면 사용자가 지운 적 없는 행의 창과 그 아래 전부가 사라진다.
// FR-EDT-115 / D-26: 디렉터리 이동은 이름을 먼저 예약하므로, 검사와 콜 사이에
// 대상이 생겨도 **조용히 덮어쓰지 않는다.** 병렬로 같은 대상을 노리는 이동
// 여러 건 중 하나만 성공해야 한다.
// FR-EDT-86·115 / D-26: **일반 파일**이 가장 위험한 자리다 — `os.Rename` 은
// 기존 파일을 조용히 덮어쓴다. `os.Link` 로 이름을 원자적으로 잡으므로 병렬로
// 같은 대상을 노려도 하나만 이기고, 진 쪽의 내용은 남는다.
func TestFSRenameFileNeverOverwrites(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)

	const n = 8
	for i := 0; i < n; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("f%d.txt", i)),
			[]byte(fmt.Sprintf("body-%d", i)), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	dst := filepath.Join(root, "dst.txt")

	var wg sync.WaitGroup
	codes := make([]int, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], _ = fsReq(t, srv, "POST", "/api/fs/rename",
				fmt.Sprintf(`{"root":%q,"from":%q,"to":%q}`,
					root, filepath.Join(root, fmt.Sprintf("f%d.txt", i)), dst))
		}(i)
	}
	wg.Wait()

	won := -1
	okCount := 0
	for i, c := range codes {
		if c == 200 {
			okCount++
			won = i
		}
	}
	if okCount != 1 {
		t.Fatalf("성공 %d건, want 1 (codes=%v)", okCount, codes)
	}
	// 이긴 쪽의 내용이 그대로여야 한다 — 덮어썼다면 다른 본문이 들어 있다.
	got, err := os.ReadFile(dst)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != fmt.Sprintf("body-%d", won) {
		t.Fatalf("내용=%q, 이긴 쪽은 %d 번", got, won)
	}
	// 이긴 쪽의 원래 이름은 사라지고, 진 쪽들은 제자리에 남는다.
	if _, err := os.Lstat(filepath.Join(root, fmt.Sprintf("f%d.txt", won))); err == nil {
		t.Fatal("이긴 쪽의 원래 이름이 남아 있다 (하드링크 정리 실패)")
	}
	left := 0
	for i := 0; i < n; i++ {
		if _, err := os.Lstat(filepath.Join(root, fmt.Sprintf("f%d.txt", i))); err == nil {
			left++
		}
	}
	if left != n-1 {
		t.Fatalf("제자리에 남은 것 %d개, want %d", left, n-1)
	}
}

func TestFSRenameDirNeverOverwrites(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)

	const n = 8
	for i := 0; i < n; i++ {
		src := filepath.Join(root, fmt.Sprintf("src%d", i))
		if err := os.MkdirAll(filepath.Join(src, "inner"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	dst := filepath.Join(root, "dst")

	var wg sync.WaitGroup
	codes := make([]int, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i], _ = fsReq(t, srv, "POST", "/api/fs/rename",
				fmt.Sprintf(`{"root":%q,"from":%q,"to":%q}`,
					root, filepath.Join(root, fmt.Sprintf("src%d", i)), dst))
		}(i)
	}
	wg.Wait()

	okCount := 0
	for _, c := range codes {
		if c == 200 {
			okCount++
		}
	}
	if okCount != 1 {
		t.Fatalf("성공 %d건, want 1 (codes=%v)", okCount, codes)
	}
	// 이긴 쪽의 내용이 온전해야 한다 — 진 쪽이 덮어썼다면 inner 가 사라진다.
	if _, err := os.Stat(filepath.Join(dst, "inner")); err != nil {
		t.Fatalf("이동된 디렉터리의 내용이 손상됐다: %v", err)
	}
	// 진 쪽들은 제자리에 남아야 한다.
	left := 0
	for i := 0; i < n; i++ {
		if _, err := os.Stat(filepath.Join(root, fmt.Sprintf("src%d", i))); err == nil {
			left++
		}
	}
	if left != n-1 {
		t.Fatalf("제자리에 남은 것 %d개, want %d", left, n-1)
	}
}

func TestFSDeleteRejectsOtherEditorRoot(t *testing.T) {
	srv, ws, _ := fsTestServer(t)
	outer := wsentry.NormalizePath(t.TempDir())
	inner := filepath.Join(outer, "nested")
	if err := os.Mkdir(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	ws.raw = []byte(fmt.Sprintf(`{"schemaVersion":2,"editors":{"list":[%q,%q]}}`, outer, inner))

	code, out := fsReq(t, srv, "POST", "/api/fs/delete",
		fmt.Sprintf(`{"root":%q,"path":%q}`, outer, inner))
	if code != 400 {
		t.Fatalf("code=%d out=%v, want 400", code, out)
	}
	if _, err := os.Stat(inner); err != nil {
		t.Fatalf("안쪽 루트가 지워졌다: %v", err)
	}
}

// FR-EDT-23 / D-16: 파일시스템 루트는 행이 될 수 없다. 행이 되면 그 루트를
// 기준 삼는 조작이 파일시스템 전체를 대상으로 삼는다.
func TestEditorAddRejectsFilesystemRoot(t *testing.T) {
	srv, _, _ := fsTestServer(t)
	code, out := fsReq(t, srv, "POST", "/api/editors/add", `{"path":`+testpath.JSONQuote(testpath.Root())+`}`)
	if code == 200 {
		t.Fatalf("파일시스템 루트가 행으로 들어갔다: %v", out)
	}
}

func TestFSUnderRootAllowsDotDotNames(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"..b", "...", ".git", "..", "normal"} {
		got, err := fsUnderRoot(root, filepath.Join(root, name))
		if name == ".." {
			continue // filepath.Join 이 정규화하므로 대상이 아니다
		}
		if err != nil {
			t.Fatalf("%q 가 루트 밖으로 거부됐다: %v", name, err)
		}
		if got != filepath.Join(root, name) {
			t.Fatalf("%q: got %q", name, got)
		}
	}
	// 실제 이탈은 여전히 막힌다.
	if _, err := fsUnderRoot(root, filepath.Dir(root)); err == nil {
		t.Fatal("부모 디렉터리가 통과했다")
	}
	if _, err := fsUnderRoot(root, root+"-sibling"); err == nil {
		t.Fatal("형제 디렉터리가 통과했다")
	}
}

func TestFSList_IncludesDotEntries(t *testing.T) {
	s, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)
	for _, n := range []string{".hidden", "visible.txt"} {
		if err := os.WriteFile(filepath.Join(root, n), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(root, ".dotdir"), 0o755); err != nil {
		t.Fatal(err)
	}
	code, out := fsReq(t, s, http.MethodGet, "/api/fs/list?root="+root+"&path="+root, "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	names := entryNames(t, out)
	// 폴더 먼저, 그 다음 파일. 각각 이름 오름차순(대소문자 무시) (FR-EDT-61).
	want := []string{".dotdir", ".hidden", "visible.txt"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("entries=%v want=%v", names, want)
	}
	if out["truncated"] != false {
		t.Fatalf("truncated=%v", out["truncated"])
	}
	if out["path"] != root {
		t.Fatalf("path=%v want=%v", out["path"], root)
	}
	first, _ := out["entries"].([]any)[0].(map[string]any)
	for _, k := range []string{"name", "dir", "link", "linkDir"} {
		if _, ok := first[k]; !ok {
			t.Fatalf("%s 가 없다: %v", k, first)
		}
	}
	// 크기·수정시각은 주지 않는다 — 소비하는 요구가 없다 (FR-EDT-108).
	if len(first) != 4 {
		t.Fatalf("엔트리에 필요 없는 필드가 있다: %v", first)
	}
}

// FR-EDT-60·108: 링크는 dir:false 이고 linkDir 이 대상의 종류를 알린다.
func TestFSList_LinkEntries(t *testing.T) {
	s, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)
	realDir := filepath.Join(root, "d")
	realFile := filepath.Join(root, "f.txt")
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(realFile, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(realDir, filepath.Join(root, "ld")); err != nil {
		t.Skipf("심볼릭 링크를 만들 수 없다: %v", err)
	}
	if err := os.Symlink(realFile, filepath.Join(root, "lf")); err != nil {
		t.Fatal(err)
	}
	_, out := fsReq(t, s, http.MethodGet, "/api/fs/list?root="+root+"&path="+root, "")
	got := map[string]map[string]any{}
	for _, v := range out["entries"].([]any) {
		e, _ := v.(map[string]any)
		got[fmt.Sprint(e["name"])] = e
	}
	if e := got["ld"]; e["dir"] != false || e["link"] != true || e["linkDir"] != true {
		t.Fatalf("ld=%v", e)
	}
	if e := got["lf"]; e["dir"] != false || e["link"] != true || e["linkDir"] != false {
		t.Fatalf("lf=%v", e)
	}
	if e := got["d"]; e["dir"] != true || e["link"] != false {
		t.Fatalf("d=%v", e)
	}
}

// V-EDT-45 (FR-EDT-65·108): 상한을 넘으면 잘라내고 truncated:true 다.
// **실패가 아니다** — 200 이어야 탐색기가 그 폴더를 열 수 있다.
func TestFSList_TruncatesWithoutFailing(t *testing.T) {
	s, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)
	for i := 0; i < 5; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("f%d", i)), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	restore := fsListMax
	fsListMax = 3
	defer func() { fsListMax = restore }()

	code, out := fsReq(t, s, http.MethodGet, "/api/fs/list?root="+root+"&path="+root, "")
	if code != 200 {
		t.Fatalf("잘림이 실패가 됐다: code=%d body=%v", code, out)
	}
	if out["truncated"] != true {
		t.Fatalf("truncated=%v", out["truncated"])
	}
	if n := len(entryNames(t, out)); n != 3 {
		t.Fatalf("entries=%d, want 3", n)
	}
}

// V-EDT-65 (FR-EDT-113): editors.list 에도 홈에도 없는 root 는 거부한다.
func TestFS_RejectsUnknownRoot(t *testing.T) {
	s, ws, home := fsTestServer(t)
	other := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, other)

	code, out := fsReq(t, s, http.MethodGet, "/api/fs/list?root="+url.QueryEscape(testpath.Abs("etc"))+"&path="+url.QueryEscape(testpath.Abs("etc")), "")
	if code != http.StatusForbidden || out["code"] != fsErrOutsideRoot {
		t.Fatalf("code=%d body=%v", code, out)
	}
	// 홈은 root 행이므로 언제나 유효하다 (FR-EDT-13).
	if code, out := fsReq(t, s, http.MethodGet, "/api/fs/list?root="+home+"&path="+home, ""); code != 200 {
		t.Fatalf("홈이 거부됐다: code=%d body=%v", code, out)
	}
}

// V-EDT-83 (FR-EDT-111): 상대경로 인자는 400 이다.
func TestFS_RejectsRelativePaths(t *testing.T) {
	s, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)

	cases := []struct{ method, path, body string }{
		{http.MethodGet, "/api/fs/list?root=rel&path=" + root, ""},
		{http.MethodGet, "/api/fs/list?root=" + root + "&path=rel", ""},
		{http.MethodPost, "/api/fs/create", `{"root":` + testpath.JSONQuote(root) + `,"path":"rel"}`},
		{http.MethodPost, "/api/fs/rename", `{"root":` + testpath.JSONQuote(root) + `,"from":"rel","to":` + testpath.JSONQuote(root+"/x") + `}`},
		{http.MethodPost, "/api/fs/rename", `{"root":` + testpath.JSONQuote(root) + `,"from":` + testpath.JSONQuote(root+"/x") + `,"to":"rel"}`},
		{http.MethodPost, "/api/fs/delete", `{"root":` + testpath.JSONQuote(root) + `,"path":"rel"}`},
		{http.MethodPost, "/api/editors/add", `{"path":"rel"}`},
		{http.MethodPost, "/api/editors/remove", `{"path":"rel"}`},
		{http.MethodPost, "/api/editors/reorder", `{"src":"rel","target":` + testpath.JSONQuote(root) + `}`},
	}
	for _, c := range cases {
		code, out := fsReq(t, s, c.method, c.path, c.body)
		if code != http.StatusBadRequest || out["code"] != fsErrBadRequest {
			t.Errorf("%s %s %s → code=%d body=%v", c.method, c.path, c.body, code, out)
		}
	}
}

// V-EDT-84 (FR-EDT-117): 오류 응답은 {code, message} 다.
func TestFS_ErrorShape(t *testing.T) {
	s, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)
	code, out := fsReq(t, s, http.MethodGet, "/api/fs/list?root="+root+"&path="+root+"/nope", "")
	if code != http.StatusNotFound {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if out["code"] != fsErrNotFound {
		t.Fatalf("code 필드=%v want=%q", out["code"], fsErrNotFound)
	}
	if msg, _ := out["message"].(string); msg == "" {
		t.Fatalf("message 가 비었다: %v", out)
	}
	if len(out) != 2 {
		t.Fatalf("오류 본문에 다른 키가 있다: %v", out)
	}
}

// V-EDT-62 (FR-EDT-86·115): 같은 이름이 있으면 생성이 거부되고 덮어쓰지 않는다.
// 검사와 생성 사이의 경합은 O_EXCL·Mkdir 의 원자성으로 막는다.
func TestFSCreate_RejectsExisting(t *testing.T) {
	s, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)

	file := filepath.Join(root, "a.txt")
	if code, out := fsReq(t, s, http.MethodPost, "/api/fs/create", `{"root":`+testpath.JSONQuote(root)+`,"path":`+testpath.JSONQuote(file)+`}`); code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if err := os.WriteFile(file, []byte("keep"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out := fsReq(t, s, http.MethodPost, "/api/fs/create", `{"root":`+testpath.JSONQuote(root)+`,"path":`+testpath.JSONQuote(file)+`}`)
	if code != http.StatusConflict || out["code"] != fsErrExists {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if b, _ := os.ReadFile(file); string(b) != "keep" {
		t.Fatalf("덮어썼다: %q", b)
	}

	dir := filepath.Join(root, "d")
	if code, out := fsReq(t, s, http.MethodPost, "/api/fs/create", `{"root":`+testpath.JSONQuote(root)+`,"path":`+testpath.JSONQuote(dir)+`,"dir":true}`); code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		t.Fatalf("폴더가 안 생겼다: %v", err)
	}
	if code, _ := fsReq(t, s, http.MethodPost, "/api/fs/create", `{"root":`+testpath.JSONQuote(root)+`,"path":`+testpath.JSONQuote(dir)+`,"dir":true}`); code != http.StatusConflict {
		t.Fatalf("code=%d", code)
	}
}

// V-EDT-62 (FR-EDT-86·115): to 가 이미 있으면 rename 을 거부한다.
func TestFSRename_RejectsExistingTarget(t *testing.T) {
	s, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)
	from, to := filepath.Join(root, "a"), filepath.Join(root, "b")
	if err := os.WriteFile(from, []byte("A"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(to, []byte("B"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, out := fsReq(t, s, http.MethodPost, "/api/fs/rename", `{"root":`+testpath.JSONQuote(root)+`,"from":`+testpath.JSONQuote(from)+`,"to":`+testpath.JSONQuote(to)+`}`)
	if code != http.StatusConflict || out["code"] != fsErrExists {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if b, _ := os.ReadFile(to); string(b) != "B" {
		t.Fatalf("덮어썼다: %q", b)
	}
	// 없는 from 은 not_found 다.
	code, out = fsReq(t, s, http.MethodPost, "/api/fs/rename", `{"root":`+testpath.JSONQuote(root)+`,"from":`+testpath.JSONQuote(root+"/zz")+`,"to":`+testpath.JSONQuote(root+"/yy")+`}`)
	if code != http.StatusNotFound || out["code"] != fsErrNotFound {
		t.Fatalf("code=%d body=%v", code, out)
	}
	// 정상 경로.
	if code, out := fsReq(t, s, http.MethodPost, "/api/fs/rename", `{"root":`+testpath.JSONQuote(root)+`,"from":`+testpath.JSONQuote(from)+`,"to":`+testpath.JSONQuote(root+"/c")+`}`); code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if b, _ := os.ReadFile(filepath.Join(root, "c")); string(b) != "A" {
		t.Fatalf("옮겨지지 않았다: %q", b)
	}
}

// V-EDT-63 (FR-EDT-87·112): 루트 밖 경로의 조작은 outside_root 다.
func TestFS_RejectsOutsideRoot(t *testing.T) {
	s, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	outside := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)
	victim := filepath.Join(outside, "victim.txt")
	if err := os.WriteFile(victim, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ path, body string }{
		{"/api/fs/create", `{"root":` + testpath.JSONQuote(root) + `,"path":` + testpath.JSONQuote(outside+"/new.txt") + `}`},
		{"/api/fs/delete", `{"root":` + testpath.JSONQuote(root) + `,"path":` + testpath.JSONQuote(victim) + `}`},
		{"/api/fs/rename", `{"root":` + testpath.JSONQuote(root) + `,"from":` + testpath.JSONQuote(victim) + `,"to":` + testpath.JSONQuote(root+"/x") + `}`},
	}
	for _, c := range cases {
		code, out := fsReq(t, s, http.MethodPost, c.path, c.body)
		if code != http.StatusForbidden || out["code"] != fsErrOutsideRoot {
			t.Errorf("%s → code=%d body=%v", c.path, code, out)
		}
	}
	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("루트 밖 파일이 지워졌다: %v", err)
	}
}

// V-EDT-64 (FR-EDT-112): 링크를 통한 루트 이탈은 `..` 검사만으로는 막히지 않는다.
func TestFS_RejectsSymlinkEscape(t *testing.T) {
	s, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	outside := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)
	if err := os.Symlink(outside, filepath.Join(root, "esc")); err != nil {
		t.Skipf("심볼릭 링크를 만들 수 없다: %v", err)
	}
	victim := filepath.Join(outside, "victim.txt")
	if err := os.WriteFile(victim, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	via := filepath.Join(root, "esc", "victim.txt")
	code, out := fsReq(t, s, http.MethodPost, "/api/fs/delete", `{"root":`+testpath.JSONQuote(root)+`,"path":`+testpath.JSONQuote(via)+`}`)
	if code != http.StatusForbidden || out["code"] != fsErrOutsideRoot {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if _, err := os.Stat(victim); err != nil {
		t.Fatalf("링크를 통해 루트 밖이 지워졌다: %v", err)
	}
	// 조회도 같다.
	code, out = fsReq(t, s, http.MethodGet, "/api/fs/list?root="+root+"&path="+filepath.Join(root, "esc"), "")
	if code != http.StatusForbidden || out["code"] != fsErrOutsideRoot {
		t.Fatalf("list code=%d body=%v", code, out)
	}
}

// V-EDT-66 (FR-EDT-114): 루트 자신·홈·파일시스템 루트의 삭제는 거부한다.
func TestFSDelete_RejectsRootHomeAndFsRoot(t *testing.T) {
	s, ws, home := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	ws.raw = []byte(fmt.Sprintf(`{"schemaVersion":2,"editors":{"list":[%q]}}`, root))

	for _, c := range []struct{ root, path, want string }{
		{root, root, fsErrBadRequest},
		{home, home, fsErrBadRequest},
		// `/` 는 어느 Editor 루트보다도 위이므로 루트 가드가 먼저 잡는다 — 거부의
		// 사유가 더 강할 뿐 결과는 같다.
		{home, testpath.Root(), fsErrOutsideRoot},
	} {
		code, out := fsReq(t, s, http.MethodPost, "/api/fs/delete", `{"root":`+testpath.JSONQuote(c.root)+`,"path":`+testpath.JSONQuote(c.path)+`}`)
		if code < 400 || out["code"] != c.want {
			t.Errorf("delete %s (root=%s) → code=%d body=%v", c.path, c.root, code, out)
		}
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("루트가 지워졌다: %v", err)
	}
	// 루트가 `/` 인 극단(사용자가 `/` 를 Editor 행으로 넣은 경우)에서도 파일시스템
	// 루트는 지워지지 않는다.
	if err := s.fsDeletable(testpath.Root(), testpath.Root()); err == nil {
		t.Fatal("파일시스템 루트의 삭제가 통과했다")
	}
}

// V-EDT-67 (FR-EDT-118): 상한을 넘으면 **아무것도 지우지 않고** 실패한다 —
// 세다가 중간에 멈추지 않는다.
func TestFSDelete_OverMaxDeletesNothing(t *testing.T) {
	s, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)
	target := filepath.Join(root, "tree")
	if err := os.MkdirAll(filepath.Join(target, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if err := os.WriteFile(filepath.Join(target, "sub", fmt.Sprintf("f%d", i)), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	restore := fsDeleteMax
	fsDeleteMax = 3
	defer func() { fsDeleteMax = restore }()

	code, out := fsReq(t, s, http.MethodPost, "/api/fs/delete", `{"root":`+testpath.JSONQuote(root)+`,"path":`+testpath.JSONQuote(target)+`}`)
	if code != http.StatusBadRequest || out["code"] != fsErrBadRequest {
		t.Fatalf("code=%d body=%v", code, out)
	}
	des, err := os.ReadDir(filepath.Join(target, "sub"))
	if err != nil || len(des) != 5 {
		t.Fatalf("일부가 지워졌다: %d개 (%v)", len(des), err)
	}

	fsDeleteMax = restore
	if code, out := fsReq(t, s, http.MethodPost, "/api/fs/delete", `{"root":`+testpath.JSONQuote(root)+`,"path":`+testpath.JSONQuote(target)+`}`); code != 200 {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("지워지지 않았다: %v", err)
	}
}

// V-EDT-8·10·11 (FR-EDT-16·19·25·29·110): Editor 목록 종단의 왕복.
func TestEditors_Endpoints(t *testing.T) {
	s, ws, home := fsTestServer(t)
	a := wsentry.NormalizePath(t.TempDir())
	b := wsentry.NormalizePath(t.TempDir())

	code, out := fsReq(t, s, http.MethodGet, "/api/editors", "")
	if code != 200 || out["home"] != home {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if list, ok := out["list"].([]any); !ok || len(list) != 0 {
		t.Fatalf("list=%v", out["list"])
	}

	for i := 0; i < 2; i++ { // 멱등 (FR-EDT-25)
		code, out = fsReq(t, s, http.MethodPost, "/api/editors/add", `{"path":`+testpath.JSONQuote(a)+`}`)
		if code != 200 {
			t.Fatalf("add code=%d body=%v", code, out)
		}
		if list, _ := out["list"].([]any); len(list) != 1 || list[0] != a {
			t.Fatalf("list=%v", out["list"])
		}
		if _, ok := out["pinned"]; !ok {
			t.Fatalf("응답에 pinned 가 없다 (FR-EDT-39): %v", out)
		}
	}

	// V-EDT-8 (FR-EDT-16): 홈 추가는 성공이되 목록을 바꾸지 않는다.
	saves := ws.saves
	code, out = fsReq(t, s, http.MethodPost, "/api/editors/add", `{"path":`+testpath.JSONQuote(home)+`}`)
	if code != 200 {
		t.Fatalf("홈 추가 code=%d body=%v", code, out)
	}
	if list, _ := out["list"].([]any); len(list) != 1 {
		t.Fatalf("홈 추가가 목록을 바꿨다: %v", out["list"])
	}
	if ws.saves != saves {
		t.Fatalf("목록이 안 변하는데 저장했다")
	}

	if code, out = fsReq(t, s, http.MethodPost, "/api/editors/add", `{"path":`+testpath.JSONQuote(b)+`}`); code != 200 {
		t.Fatalf("add code=%d body=%v", code, out)
	}
	// FR-EDT-27: (src, target, before) 델타.
	code, out = fsReq(t, s, http.MethodPost, "/api/editors/reorder", `{"src":`+testpath.JSONQuote(b)+`,"target":`+testpath.JSONQuote(a)+`,"before":true}`)
	if code != 200 {
		t.Fatalf("reorder code=%d body=%v", code, out)
	}
	if list, _ := out["list"].([]any); len(list) != 2 || list[0] != b {
		t.Fatalf("list=%v", out["list"])
	}

	code, out = fsReq(t, s, http.MethodPost, "/api/editors/remove", `{"path":`+testpath.JSONQuote(b)+`}`)
	if code != 200 {
		t.Fatalf("remove code=%d body=%v", code, out)
	}
	if list, _ := out["list"].([]any); len(list) != 1 || list[0] != a {
		t.Fatalf("list=%v", out["list"])
	}

	// FR-EDT-23: 존재하지 않으면 404, 파일이면 400.
	if code, out := fsReq(t, s, http.MethodPost, "/api/editors/add", `{"path":`+testpath.JSONQuote(a+"/nope")+`}`); code != http.StatusNotFound || out["code"] != fsErrNotFound {
		t.Fatalf("code=%d body=%v", code, out)
	}
	f := filepath.Join(a, "f.txt")
	if err := os.WriteFile(f, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if code, out := fsReq(t, s, http.MethodPost, "/api/editors/add", `{"path":`+testpath.JSONQuote(f)+`}`); code != http.StatusBadRequest || out["code"] != fsErrBadRequest {
		t.Fatalf("code=%d body=%v", code, out)
	}
}

// FR-EDT-108~110: 8개 라우트가 등록돼 있다.
func TestFSRoutesRegistered(t *testing.T) {
	eps := []struct{ method, path string }{
		{http.MethodGet, "/api/fs/list"},
		{http.MethodPost, "/api/fs/create"},
		{http.MethodPost, "/api/fs/rename"},
		{http.MethodPost, "/api/fs/delete"},
		{http.MethodGet, "/api/editors"},
		{http.MethodPost, "/api/editors/add"},
		{http.MethodPost, "/api/editors/remove"},
		{http.MethodPost, "/api/editors/reorder"},
	}
	for _, ep := range eps {
		found := false
		for _, rt := range apiRoutes {
			if rt.method != "" && rt.method != ep.method {
				continue
			}
			if rt.match(ep.path) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("%s %s 가 apiRoutes 에 없다", ep.method, ep.path)
		}
		// FR-EDT-119: 스킵 목록에 넣지 않는다. 조회는 사용자 조작당 한 번이다.
		if !shouldLogRequest(ep.path, 200) {
			t.Errorf("%s 가 로그 스킵 목록에 걸렸다", ep.path)
		}
	}
}

// workspace 가 없으면 이 종단만 실패한다 — 패닉하지 않고 {code,message} 를 낸다.
func TestFS_WithoutWorkspaceFailsCleanly(t *testing.T) {
	t.Setenv(testpath.HomeEnv(), t.TempDir())
	s, err := New(Config{Port: "0", DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/editors", ""},
		{http.MethodGet, "/api/fs/list?root=/tmp&path=/tmp", ""},
		{http.MethodPost, "/api/editors/add", `{"path":"/tmp"}`},
	} {
		code, out := fsReq(t, s, c.method, c.path, c.body)
		if code < 400 || out["code"] == nil {
			t.Errorf("%s %s → code=%d body=%v", c.method, c.path, code, out)
		}
	}
	if code, _ := fsReq(t, s, "", "/api/ping", ""); code != 200 {
		t.Fatalf("다른 종단이 함께 막혔다: /api/ping → %d", code)
	}
}

// V-EDT-96 (FR-EDT-117): 권한 실패는 404 가 아니라 403 `permission_denied` 다.
//
// 전부 not_found 로 접으면 "권한이 없어서 못 본 것" 과 "없는 것" 이 같은 답을
// 받아, 사용자가 무엇을 고쳐야 할지 알 수 없다. 경로 해석 실패(EvalSymlinks)와
// 조회 실패(ReadDir) 둘 다 그 구분을 지켜야 하므로 함께 잰다.
func TestFSListPermissionDeniedNot404(t *testing.T) {
	// root 는 권한 검사를 그냥 통과한다 — 그대로 두면 이 테스트는 언제나 통과하는
	// 가짜가 된다.
	// 권한 비트로 거부를 만드는 검사다. NTFS 에는 그 개념이 없어
	// chmod(0o000) 이 아무 효과도 내지 않는다 (FR-WTP-31).
	if !testpath.PermChecked() {
		t.Skip("유닉스 권한 비트가 없는 OS 다 — 거부 상황을 만들 수 없다")
	}
	if os.Geteuid() == 0 {
		t.Skip("root 로는 권한 거부를 만들 수 없다")
	}
	srv, ws, _ := fsTestServer(t)
	root := wsentry.NormalizePath(t.TempDir())
	seedRoot(t, ws, root)

	locked := filepath.Join(root, "locked")
	if err := os.Mkdir(locked, 0o755); err != nil {
		t.Fatal(err)
	}
	inner := filepath.Join(locked, "sub")
	if err := os.Mkdir(inner, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatal(err)
	}
	// 되돌리지 않으면 t.TempDir 의 정리가 실패한다.
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	for _, p := range []string{locked, inner} {
		code, out := fsReq(t, srv, http.MethodGet,
			fmt.Sprintf("/api/fs/list?root=%s&path=%s", url.QueryEscape(root), url.QueryEscape(p)), "")
		if code != http.StatusForbidden || out["code"] != "permission_denied" {
			t.Fatalf("path=%s → code=%d body=%v, want 403 permission_denied", p, code, out)
		}
	}
}

// V-EDT-87 (NFR-EDT-1): 항목 1,000개 폴더의 list 가 100ms 이내다.
func BenchmarkFSList1000(b *testing.B) {
	dir := b.TempDir()
	for i := 0; i < 1000; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("entry-%04d.txt", i)), nil, 0o644); err != nil {
			b.Fatal(err)
		}
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		entries, truncated, err := fsListDir(dir, fsListMax)
		if err != nil || truncated || len(entries) != 1000 {
			b.Fatalf("entries=%d truncated=%v err=%v", len(entries), truncated, err)
		}
	}
	if per := b.Elapsed() / time.Duration(b.N); per > 100*time.Millisecond {
		b.Fatalf("1회 %v — NFR-EDT-1 의 100ms 를 넘었다", per)
	}
}
