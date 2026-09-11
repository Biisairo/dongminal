package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/toolhub"
	"dongminal/internal/webserver/domain/wsentry"
)

// FILE_API_BOUNDARY_SRS §4 — `/api/file/*` 의 경계 (TC-FAB-1~12).
//
// 이 종단에는 단위 테스트가 **0건**이었다 (05-test §1 의 P0). 편집기의 저장이 이
// 경로이므로, 여기서 잘리는 것은 우리 상태 파일이 아니라 **사용자가 쓰던 원본**이다.
//
// 그리고 가드가 없었다. `filepath.IsAbs` 하나만 보고 `WriteFileAtomic` 을 불렀으므로
// `~/.ssh/authorized_keys` 를 덮을 수 있었다 — 응답을 읽을 필요조차 없는 요청
// 하나로. 그것은 PTY 보다 **쉬운** 경로이고, 난이도가 다르면 같은 위험이 아니다.

// fileBoundaryEnv 는 Editor 루트 하나와 그 밖의 자리 하나를 만든다.
type fileBoundaryEnv struct {
	ts      *httptest.Server
	root    string  // Editor 목록에 든 루트
	outside string  // 아무 목록에도 없는 자리
	data    string  // $DONGMINAL_HOME — 자기 상태의 자리 (묶음 W)
	server  *Server // 경계 판정을 직접 부르는 테스트용 (묶음 G)
}

func newFileBoundaryEnv(t *testing.T) *fileBoundaryEnv {
	t.Helper()
	return newFileBoundaryEnvWith(t, nil)
}

// newFileBoundaryEnvWith 는 서버가 서기 **전에** 홈을 채울 기회를 준다. 설정은
// 기동 시 한 번 읽히므로(Settings), 뒤에 쓰면 그 판정에 닿지 않는다.
func newFileBoundaryEnvWith(t *testing.T, prepare func(data string)) *fileBoundaryEnv {
	t.Helper()
	base := t.TempDir()
	if resolved, err := filepath.EvalSymlinks(base); err == nil {
		base = resolved
	}
	root := filepath.Join(base, "proj")
	outside := filepath.Join(base, "elsewhere")
	for _, d := range []string{root, outside} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	data := t.TempDir()
	if resolved, err := filepath.EvalSymlinks(data); err == nil {
		data = resolved
	}
	if prepare != nil {
		prepare(data)
	}
	work := newFakeWorkspaceStore()
	srv, err := New(Config{DataDir: data}, Deps{Work: work})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// **홈을 고정한다** (WINDOWS_TEST_PARITY_SRS FR-WTP-10 의 뜻).
	//
	// `Roots()` 의 첫 항목은 `os.UserHomeDir` 이다 (FR-FAB-2). 그것을 그대로 두면
	// "경계 밖" 이 **플랫폼에 따라 달라진다** — Windows 의 `TempDir` 은
	// `C:\Users\<user>\AppData\Local\Temp` 라 홈 **아래**이고, 그러면 이 파일이
	// `outside` 라 부르는 자리가 실제로는 경계 안이다 (Windows CI 가 잡았다).
	//
	// 홈을 Editor 루트로 고정하면 두 OS 에서 같은 것을 재게 된다.
	srv.Entries.HomeFn = func() (string, error) { return root, nil }
	// Editor 목록에 루트 하나를 넣는다 — 편집기가 여는 자리가 곧 쓰기가 닿아도
	// 되는 자리다.
	if _, err := srv.Entries.Mutate(func(cur wsentry.Lists) wsentry.Lists {
		cur.Editors = append(cur.Editors, root)
		return cur
	}); err != nil {
		t.Fatalf("Editor 루트 등록: %v", err)
	}

	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return &fileBoundaryEnv{ts: ts, root: root, outside: outside, data: data, server: srv}
}

// write 는 `POST /api/file/write` 한 번이다.
func (e *fileBoundaryEnv) write(t *testing.T, path, content string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"path": path, "content": content})
	req, _ := http.NewRequest(http.MethodPost, e.ts.URL+"/api/file/write", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	defer resp.Body.Close()
	b := make([]byte, 1024)
	n, _ := resp.Body.Read(b)
	return resp.StatusCode, string(b[:n])
}

// TC-FAB-1: 허용 루트 아래 정상 쓰기.
func TestFileWrite_InsideRootSucceeds(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "note.txt")
	code, body := e.write(t, target, "hello\n")
	if code != http.StatusOK {
		t.Fatalf("status=%d body=%q", code, body)
	}
	if !strings.Contains(body, `"ok":true`) {
		t.Fatalf("body=%q", body)
	}
	got, err := os.ReadFile(target)
	if err != nil || string(got) != "hello\n" {
		t.Fatalf("파일 내용=%q err=%v", got, err)
	}
}

// TC-FAB-2: 상대경로는 400.
func TestFileWrite_RelativePathIs400(t *testing.T) {
	e := newFileBoundaryEnv(t)
	if code, _ := e.write(t, "note.txt", "x"); code != http.StatusBadRequest {
		t.Fatalf("status=%d want 400", code)
	}
}

// TC-FAB-3: 빈 path 는 400.
func TestFileWrite_EmptyPathIs400(t *testing.T) {
	e := newFileBoundaryEnv(t)
	if code, _ := e.write(t, "", "x"); code != http.StatusBadRequest {
		t.Fatalf("status=%d want 400", code)
	}
}

// TC-FAB-4: 쓰기 실패는 500.
//
// 디렉터리를 대상으로 쓰면 실패한다 — 존재하는 자리이므로 경계 검사는 통과하고
// 쓰기 단계에서 걸린다.
func TestFileWrite_FailureIs500(t *testing.T) {
	e := newFileBoundaryEnv(t)
	dir := filepath.Join(e.root, "sub")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if code, _ := e.write(t, dir, "x"); code != http.StatusInternalServerError {
		t.Fatalf("status=%d want 500", code)
	}
}

// TC-FAB-5: **허용 루트 밖은 403.** 이 마일스톤의 P0 다.
func TestFileWrite_OutsideRootIs403(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.outside, "authorized_keys")
	code, body := e.write(t, target, "ssh-rsa AAAA...\n")
	if code != http.StatusForbidden {
		t.Fatalf("status=%d want 403 — 목록 밖 절대경로가 덮였다", code)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("403 인데 파일이 만들어졌다")
	}
	// 본문이 루트 목록을 흘리면 그것이 곧 다음 시도의 입력이 된다.
	if strings.Contains(body, e.root) {
		t.Fatalf("응답이 허용 루트를 흘렸다: %q", body)
	}
}

// TC-FAB-7: 살아 있는 도구의 작업 폴더도 루트다.
//
// 터미널에서 `edit <파일>` 로 여는 자리가 이것이다. 빠지면 그 흐름이 통째로 막힌다.
func TestFileWrite_ToolCwdIsRoot(t *testing.T) {
	base := t.TempDir()
	if r, err := filepath.EvalSymlinks(base); err == nil {
		base = r
	}
	cwd := filepath.Join(base, "work")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}

	pm := toolhub.NewToolManager(toolTempDir(t), nil)
	t.Cleanup(pm.StopSaving)
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Tools: pm, Work: newFakeWorkspaceStore()})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// 그 폴더에서 도구를 하나 연다.
	tool, err := pm.Create(cwd, 80, 24, toolhub.Placement{})
	if err != nil {
		t.Skipf("이 환경에서 도구를 만들 수 없다: %v", err)
	}
	t.Cleanup(func() { pm.Delete(tool.ID) })

	e := &fileBoundaryEnv{ts: ts, root: cwd}
	if code, body := e.write(t, filepath.Join(cwd, "a.txt"), "x"); code != http.StatusOK {
		t.Fatalf("status=%d body=%q — 도구 cwd 아래 쓰기가 막혔다", code, body)
	}
}

// TC-FAB-9: 루트 안의 심링크가 밖을 가리키면 막는다.
//
// 경로 문자열만 보면 루트 안이다. 풀어야 밖인 것이 드러난다.
func TestFileWrite_SymlinkEscapeIs403(t *testing.T) {
	e := newFileBoundaryEnv(t)
	victim := filepath.Join(e.outside, "secret.txt")
	if err := os.WriteFile(victim, []byte("before\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(e.root, "link.txt")
	if err := os.Symlink(victim, link); err != nil {
		t.Skipf("심링크를 만들 수 없다: %v", err)
	}

	if code, _ := e.write(t, link, "after\n"); code != http.StatusForbidden {
		t.Fatalf("status=%d want 403 — 링크를 통해 루트 밖을 덮었다", code)
	}
	got, _ := os.ReadFile(victim)
	if string(got) != "before\n" {
		t.Fatalf("루트 밖 파일이 바뀌었다: %q", got)
	}
}

// TC-FAB-10: 중간 디렉터리가 링크로 루트를 벗어나도 막는다.
func TestFileWrite_SymlinkedParentIs403(t *testing.T) {
	e := newFileBoundaryEnv(t)
	linkDir := filepath.Join(e.root, "out")
	if err := os.Symlink(e.outside, linkDir); err != nil {
		t.Skipf("심링크를 만들 수 없다: %v", err)
	}
	target := filepath.Join(linkDir, "new.txt")
	if code, _ := e.write(t, target, "x"); code != http.StatusForbidden {
		t.Fatalf("status=%d want 403 — 링크 디렉터리를 지나 루트 밖에 썼다", code)
	}
	if _, err := os.Stat(filepath.Join(e.outside, "new.txt")); !os.IsNotExist(err) {
		t.Fatalf("루트 밖에 파일이 만들어졌다")
	}
}

// TC-FAB-11: `read`·`probe`·`raw` 도 같은 판정이다.
//
// 쓰기만 막고 읽기를 열어 두면 `~/.ssh/id_ed25519`·`~/.aws/credentials` 가 그대로
// 나간다 — 이 종단들은 응답을 돌려주므로 오히려 더 직접적이다.
func TestFileRead_OutsideRootIs403(t *testing.T) {
	e := newFileBoundaryEnv(t)
	victim := filepath.Join(e.outside, "id_ed25519")
	if err := os.WriteFile(victim, []byte("PRIVATE KEY\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/file/read", "/api/file/probe", "/api/file/raw"} {
		resp, err := http.Get(e.ts.URL + path + "?path=" + victim)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		b := make([]byte, 512)
		n, _ := resp.Body.Read(b)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s status=%d want 403", path, resp.StatusCode)
		}
		if strings.Contains(string(b[:n]), "PRIVATE KEY") {
			t.Fatalf("%s 가 내용을 흘렸다", path)
		}
	}
}

// TC-FAB-6: 허용 루트 아래 읽기는 그대로 된다.
func TestFileRead_InsideRootSucceeds(t *testing.T) {
	e := newFileBoundaryEnv(t)
	target := filepath.Join(e.root, "ok.txt")
	if err := os.WriteFile(target, []byte("visible\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	resp, err := http.Get(e.ts.URL + "/api/file/read?path=" + target)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d want 200 — 자기 루트의 파일이 막혔다", resp.StatusCode)
	}
}
