package gitapi

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/store"
	"dongminal/internal/webserver/domain/submodule"
)

// /api/git/submodules* 의 특성화 테스트 (DRIFT_RECLAIM_SRS FR-DRC-6).
//
// **이 표면에는 단위 테스트가 하나도 없었다.** worktree 는 같은 성질인데 10개가
// 있다 — 안전망이 한쪽에만 있었다. 회수(FR-DRC-4)로 옮기기 **전에** 현재 행위를
// 여기 고정한다: 옮긴 뒤 이 파일이 그대로 통과해야 회수가 행위를 보존했다는 뜻이다.
//
// worktree 쪽 관용구를 그대로 쓴다 — 실제 git 을 쓰고, 실패 응답에 `ok` 가 아예
// 없다는 것까지 본다 (`wantNoOK`).

// jsonStr 은 경로를 JSON 문자열 리터럴로 만든다. Windows 의 `\` 를 손으로 이스케이프
// 하면 그 규칙이 테스트마다 갈린다.
func jsonStr(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// submoduleTestServer 는 실제 git 을 쓰는 GitServer 를 세운다.
func submoduleTestServer(t *testing.T) (*GitServer, string) {
	t.Helper()
	wtGitBin(t)
	repo := wtTempRepo(t)
	s := &GitServer{
		Git:        store.NewStore(core.New()),
		Submodules: submodule.New(submodule.ExecGit),
	}
	return s, repo
}

// 라우팅 등록 + Submodules 가 없으면 503 (worktree 표면과 같은 규약).
func TestGitSubmoduleRoutes_RegisteredAndUnavailable(t *testing.T) {
	s := &GitServer{}
	endpoints := []struct{ method, path, body string }{
		{http.MethodGet, "/api/git/submodules?repo=" + url.QueryEscape(absX), ""},
		{http.MethodPost, "/api/git/submodules/update", `{}`},
		{http.MethodPost, "/api/git/submodules/sync", `{}`},
	}
	for _, ep := range endpoints {
		code, out := wtReq(t, s, ep.method, ep.path, ep.body)
		if code != http.StatusServiceUnavailable {
			t.Fatalf("%s %s: 503 이어야 한다, got %d (%+v)", ep.method, ep.path, code, out)
		}
		if out["error"] != gitErrUnavailable {
			t.Fatalf("%s %s: error=%v, want %s", ep.method, ep.path, out["error"], gitErrUnavailable)
		}
		wantNoOK(t, out)
	}
}

// 서브모듈이 없는 저장소는 빈 목록이며 오류가 아니다 (FR-SUB-10).
func TestAPIGitSubmodules_EmptyRepoIsEmptyList(t *testing.T) {
	s, repo := submoduleTestServer(t)
	code, out := wtReq(t, s, http.MethodGet, "/api/git/submodules?repo="+url.QueryEscape(repo), "")
	if code != http.StatusOK {
		t.Fatalf("200 이어야 한다, got %d (%+v)", code, out)
	}
	if out["repo"] != repo {
		t.Fatalf("repo=%v, want %s", out["repo"], repo)
	}
	if out["requested"] != repo {
		t.Fatalf("requested=%v, want %s", out["requested"], repo)
	}
	list, ok := out["submodules"].([]any)
	if !ok {
		t.Fatalf("submodules 가 배열이어야 한다: %+v", out)
	}
	if len(list) != 0 {
		t.Fatalf("빈 목록이어야 한다, got %+v", list)
	}
}

// 목록은 `git submodule status` 가 진실이다 (FR-SUB-2) — 등록되었으나 초기화되지
// 않은 것도 보이고, absPath 는 서버가 계산한다 (FR-SUB-1).
func TestAPIGitSubmodules_ListsRegisteredEntryWithAbsPath(t *testing.T) {
	s, repo := submoduleTestServer(t)
	inner := wtTempRepo(t)

	// 로컬 경로를 서브모듈로 붙인다. file 프로토콜 제한이 있는 git 에서도 되도록
	// 설정을 켠다 — 이 테스트가 보려는 것은 전송이 아니라 목록의 모양이다.
	wtGitRun(t, repo, "-c", "protocol.file.allow=always",
		"submodule", "add", inner, "vendor/inner")
	wtGitRun(t, repo, "commit", "-m", "add submodule")

	code, out := wtReq(t, s, http.MethodGet, "/api/git/submodules?repo="+url.QueryEscape(repo), "")
	if code != http.StatusOK {
		t.Fatalf("200 이어야 한다, got %d (%+v)", code, out)
	}
	list, _ := out["submodules"].([]any)
	if len(list) != 1 {
		t.Fatalf("한 줄이어야 한다, got %+v", out["submodules"])
	}
	e, _ := list[0].(map[string]any)
	if e["path"] != "vendor/inner" {
		t.Fatalf("path=%v, want vendor/inner", e["path"])
	}
	wantAbs := filepath.Join(repo, filepath.FromSlash("vendor/inner"))
	if e["absPath"] != wantAbs {
		t.Fatalf("absPath=%v, want %s", e["absPath"], wantAbs)
	}
	if oid, _ := e["oid"].(string); len(oid) != 40 {
		t.Fatalf("oid 는 40자여야 한다, got %q", e["oid"])
	}
}

// 저장소가 아닌 자리는 not_a_git_repo 다 — 서브모듈 표면도 같은 규약을 쓴다.
func TestAPIGitSubmodules_NotARepo(t *testing.T) {
	s, _ := submoduleTestServer(t)
	plain, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	code, out := wtReq(t, s, http.MethodGet, "/api/git/submodules?repo="+url.QueryEscape(plain), "")
	if code == http.StatusOK {
		t.Fatalf("저장소가 아니면 실패해야 한다: %d %+v", code, out)
	}
	wantNoOK(t, out)
}

// 쓰기 둘 다 confirm 을 요구한다 (FR-SUB-4·5). **서버가 마지막 방어선이다** —
// 클라이언트만 막으면 API 직접 호출이 그대로 우회한다.
//
// 코드는 `confirmation_required` 다 (FR-DRC-5). 이전에는 이 표면만 `bad_request`
// 였고 worktree 는 `confirmation_required` 였다 — 같은 뜻에 코드가 둘이면 화면이
// 옮기는 말이 갈린다 ("잘못된 요청입니다" vs "확인이 필요합니다").
func TestAPIGitSubmoduleWrites_RequireConfirm(t *testing.T) {
	s, repo := submoduleTestServer(t)
	for _, path := range []string{"/api/git/submodules/update", "/api/git/submodules/sync"} {
		code, out := wtReq(t, s, http.MethodPost, path, `{"repo":`+jsonStr(repo)+`}`)
		if code != http.StatusBadRequest {
			t.Fatalf("%s: 400 이어야 한다, got %d (%+v)", path, code, out)
		}
		if out["error"] != gitErrConfirmRequired {
			t.Fatalf("%s: error=%v, want %s", path, out["error"], gitErrConfirmRequired)
		}
		wantNoOK(t, out)
	}
}

// confirm 검사는 repo 해석보다 **앞이다.** 순서가 뒤집히면 확인 없는 요청이
// 저장소를 먼저 건드린다.
func TestAPIGitSubmoduleWrites_ConfirmCheckedBeforeRepo(t *testing.T) {
	s, _ := submoduleTestServer(t)
	code, out := wtReq(t, s, http.MethodPost, "/api/git/submodules/update",
		`{"repo":"/definitely/not/a/repo"}`)
	if out["error"] != gitErrConfirmRequired {
		t.Fatalf("confirm 이 먼저 걸려야 한다: %d %+v", code, out)
	}
}

// 본문이 JSON 이 아니면 bad_request 다 (쓰기 표면의 공통 규약).
func TestAPIGitSubmoduleWrites_RejectsNonJSONBody(t *testing.T) {
	s, _ := submoduleTestServer(t)
	for _, path := range []string{"/api/git/submodules/update", "/api/git/submodules/sync"} {
		code, out := wtReq(t, s, http.MethodPost, path, `not json`)
		if code != http.StatusBadRequest || out["error"] != gitErrBadRequest {
			t.Fatalf("%s: 400 bad_request 여야 한다, got %d (%+v)", path, code, out)
		}
		wantNoOK(t, out)
	}
}

// 안전 가드의 거부는 클라이언트가 잘못 보낸 것이므로 400 이다 — 실행 실패(500)와
// 가른다. 사용자가 할 일이 다르기 때문이다.
func TestAPIGitSubmoduleWrites_UnsafePathIsBadRequest(t *testing.T) {
	s, repo := submoduleTestServer(t)
	body := `{"repo":` + jsonStr(repo) + `,"path":"../escape","confirm":true}`
	code, out := wtReq(t, s, http.MethodPost, "/api/git/submodules/update", body)
	if code != http.StatusBadRequest {
		t.Fatalf("400 이어야 한다, got %d (%+v)", code, out)
	}
	if out["error"] != gitErrBadRequest {
		t.Fatalf("error=%v, want %s", out["error"], gitErrBadRequest)
	}
	wantNoOK(t, out)
}

// 성공의 판정은 HTTP 200 이 아니라 본문의 `ok` 다 (FR-GIT-73) — 화면이 그것으로
// 분기한다 (`panel-write.js:166`). `repo` 는 해석된 루트다.
//
// 서브모듈이 없는 저장소에서도 두 조작은 성공이다: 대상이 없다는 것은 실패가 아니다.
func TestAPIGitSubmoduleWrites_OKCarriesResolvedRepo(t *testing.T) {
	s, repo := submoduleTestServer(t)
	// 심볼릭 링크가 아닌 하위 경로로 보내 해석이 실제로 일어나게 한다.
	sub := filepath.Join(repo, "nested")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/git/submodules/update", "/api/git/submodules/sync"} {
		body := `{"repo":` + jsonStr(sub) + `,"confirm":true}`
		code, out := wtReq(t, s, http.MethodPost, path, body)
		if code != http.StatusOK {
			t.Fatalf("%s: 200 이어야 한다, got %d (%+v)", path, code, out)
		}
		if out["ok"] != true {
			t.Fatalf("%s: ok 가 true 여야 한다: %+v", path, out)
		}
		if out["repo"] != repo {
			t.Fatalf("%s: repo=%v, want 해석된 루트 %s", path, out["repo"], repo)
		}
		// FR-DRC-4 이후 `requested` 가 실린다 — 화면의 stale 판정 근거다
		// (`panel-write.js:185`).
		if out["requested"] != sub {
			t.Fatalf("%s: requested=%v, want %s", path, out["requested"], sub)
		}
	}
}
