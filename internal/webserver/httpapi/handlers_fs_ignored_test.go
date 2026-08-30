package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// 묶음 A — 무시된 항목의 판정 (EXPLORER_TRANSFER_IGNORE_SRS §3.1, V-ETR-1~5).
//
// **실제 git 으로 검사한다.** 이 종단이 하는 일의 전부가 `check-ignore` 의 답을
// 옮기는 것이므로, 가짜로 검사하면 내가 믿는 형식을 검사하게 된다. 특히 §2.5 의
// 세 성질(추적 파일 제외 · 종료코드 1 · 디렉터리 판정)은 git 이 정한 것이라
// 픽스처로 고정할 수 없다.

// ignoreRepo 는 .gitignore 가 든 저장소를 만든다. 배치는 §2.5 의 실측과 같다 —
// 무시되는 폴더 하나, 무시되는 파일 하나, 무시되지 않는 것 하나, 그리고 패턴에
// 맞지만 **추적 중인** 파일 하나다.
func ignoreRepo(t *testing.T) string {
	t.Helper()
	bin := gitBin(t)
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command(bin, args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_SYSTEM="+os.DevNull)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	write := func(rel, body string) {
		t.Helper()
		p := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run("init", "-b", "main")
	run("config", "user.email", "t@example.com")
	run("config", "user.name", "tester")
	write(".gitignore", "node_modules/\n*.log\ntracked.log\n")
	write("node_modules/pkg/a.js", "x\n")
	write("src/main.js", "x\n")
	write("app.log", "x\n")
	write("tracked.log", "x\n")
	// -f 로 강제 추가한다. 추적 중인 파일은 패턴에 맞아도 무시로 보고되지
	// 않는다는 것이 D-3 의 근거이며, 그것을 검사하려면 이 파일이 필요하다.
	run("add", "-f", "tracked.log")
	run("add", ".gitignore", "src")
	run("commit", "-m", "init")
	return dir
}

func ignoredReq(t *testing.T, s *Server, root, dir string, names []string) (int, map[string]any) {
	t.Helper()
	body, err := json.Marshal(map[string]any{"root": root, "dir": dir, "names": names})
	if err != nil {
		t.Fatal(err)
	}
	return fsReq(t, s, http.MethodPost, "/api/fs/ignored", string(body))
}

func ignoredNames(t *testing.T, out map[string]any) []string {
	t.Helper()
	arr, ok := out["ignored"].([]any)
	if !ok {
		t.Fatalf("ignored 가 없다: %v", out)
	}
	got := make([]string, 0, len(arr))
	for _, v := range arr {
		got = append(got, fmt.Sprint(v))
	}
	return got
}

func hasName(names []string, want string) bool {
	for _, n := range names {
		if n == want {
			return true
		}
	}
	return false
}

// V-ETR-1 (FR-ETR-1·2): 무시된 것만 돌아온다. 디렉터리도 판정 대상이다.
// V-ETR-3 (FR-ETR-2, D-3): 패턴에 맞아도 **추적 중이면** 무시가 아니다 — VS Code
// 의 표시와 같은 판정을 만드는 것이 이 요구의 전부다.
func TestFSIgnored_OnlyIgnoredNames(t *testing.T) {
	repo := ignoreRepo(t)
	srv := transferSrv(t, repo)

	code, out := ignoredReq(t, srv, repo, repo,
		[]string{"node_modules", "src", "app.log", "tracked.log", ".gitignore"})
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	got := ignoredNames(t, out)

	for _, want := range []string{"node_modules", "app.log"} {
		if !hasName(got, want) {
			t.Fatalf("%q 가 무시 목록에 없다: %v", want, got)
		}
	}
	for _, no := range []string{"src", ".gitignore", "tracked.log"} {
		if hasName(got, no) {
			t.Fatalf("%q 가 무시 목록에 있다 — 무시 대상이 아니다: %v", no, got)
		}
	}
}

// V-ETR-2 (FR-ETR-3): `check-ignore` 는 무시된 것이 하나도 없으면 **종료코드 1**
// 을 낸다. 그것을 실패로 읽으면 정상이 오류가 된다.
func TestFSIgnored_NoneIsSuccess(t *testing.T) {
	repo := ignoreRepo(t)
	srv := transferSrv(t, repo)

	code, out := ignoredReq(t, srv, repo, repo, []string{"src", ".gitignore"})
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v — 종료코드 1 을 실패로 읽었다", code, out)
	}
	if got := ignoredNames(t, out); len(got) != 0 {
		t.Fatalf("ignored=%v, want 빈 목록", got)
	}
}

// FR-ETR-2: 하위 디렉터리도 그 겹의 이름으로 묻는다 — 경로가 아니라 이름을
// 보내고 `dir` 이 기준이다.
func TestFSIgnored_SubdirNames(t *testing.T) {
	repo := ignoreRepo(t)
	srv := transferSrv(t, repo)

	sub := filepath.Join(repo, "node_modules")
	code, out := ignoredReq(t, srv, repo, sub, []string{"pkg"})
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	// node_modules 아래는 전부 무시다. 클라이언트는 FR-ETR-6 으로 애초에 묻지
	// 않지만, 종단이 `dir` 을 기준으로 판정한다는 사실은 여기서 고정한다.
	if got := ignoredNames(t, out); !hasName(got, "pkg") {
		t.Fatalf("ignored=%v, want pkg", got)
	}
}

// V-ETR-4 (FR-ETR-4): 저장소가 아니면 404 not_repo 다. 클라이언트는 그 답으로
// 판정을 굳히므로(`_gitOff` 와 같은 관례) 다른 코드와 섞이면 안 된다.
func TestFSIgnored_NotRepo(t *testing.T) {
	gitBin(t)
	plain, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	srv := transferSrv(t, plain)

	code, out := ignoredReq(t, srv, plain, plain, []string{"a.txt"})
	if code != http.StatusNotFound {
		t.Fatalf("code=%d body=%v, want 404", code, out)
	}
	if out["code"] != fsErrNotRepo {
		t.Fatalf("code=%v, want %q", out["code"], fsErrNotRepo)
	}
}

// V-ETR-5 (FR-ETR-1): 루트 밖의 dir 은 403 이다. 조회·조작과 같은 가드를 받는다
// (FR-EDT-112·113).
func TestFSIgnored_RejectsOutsideRoot(t *testing.T) {
	repo := ignoreRepo(t)
	srv := transferSrv(t, repo)

	outside, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	code, out := ignoredReq(t, srv, repo, outside, []string{"a.txt"})
	if code != http.StatusForbidden {
		t.Fatalf("code=%d body=%v, want 403", code, out)
	}
	if out["code"] != fsErrOutsideRoot {
		t.Fatalf("code=%v, want %q", out["code"], fsErrOutsideRoot)
	}
}

// FR-ETR-1: 등록되지 않은 root 는 통과하지 못한다 — 서버는 클라이언트가 보낸
// root 를 신뢰하지 않는다 (FR-EDT-113).
func TestFSIgnored_RejectsUnknownRoot(t *testing.T) {
	repo := ignoreRepo(t)
	srv, _, _ := fsTestServer(t) // seedRoot 를 하지 않는다

	code, out := ignoredReq(t, srv, repo, repo, []string{"src"})
	if code != http.StatusForbidden {
		t.Fatalf("code=%d body=%v, want 403", code, out)
	}
}

// FR-ETR-1: names 가 비면 git 을 부르지 않고 빈 목록이다 — 프로세스 하나를
// 아끼는 것이 아니라, 빈 stdin 에 대한 check-ignore 의 답을 해석하지 않기
// 위해서다.
func TestFSIgnored_EmptyNames(t *testing.T) {
	repo := ignoreRepo(t)
	srv := transferSrv(t, repo)

	code, out := ignoredReq(t, srv, repo, repo, nil)
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if got := ignoredNames(t, out); len(got) != 0 {
		t.Fatalf("ignored=%v, want 빈 목록", got)
	}
}

// FR-ETR-1: 이름에 경로 구분자가 들어오면 거절한다. 이 종단이 받는 것은 **한
// 겹의 이름**이지 경로가 아니다 — 경로를 받으면 dir 밖을 판정하게 된다.
func TestFSIgnored_RejectsPathInNames(t *testing.T) {
	repo := ignoreRepo(t)
	srv := transferSrv(t, repo)

	code, out := ignoredReq(t, srv, repo, repo, []string{"../outside"})
	if code != http.StatusBadRequest {
		t.Fatalf("code=%d body=%v, want 400", code, out)
	}
}

// FR-ETR-1: 라우트가 등록돼 있는가.
func TestFSIgnoredRouteRegistered(t *testing.T) {
	found := false
	for _, rt := range apiRoutes {
		if rt.method == http.MethodPost && rt.match("/api/fs/ignored") {
			found = true
		}
	}
	if !found {
		t.Fatal("POST /api/fs/ignored 가 apiRoutes 에 없다")
	}
}
