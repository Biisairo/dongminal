package gitapi

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// GIT_EMPTY_REPO_OBSERVE_SRS — 빈 저장소는 관측이 오기 전에도 빈 저장소다 (FR-GEO-1~5).
//
// CI Windows 에서 V-GDT-12 가 졌다. 그 회차의 응답은 `commits:[]` 인데 `initial` 이
// 없었다 — 판정이 캐시된 관측에만 기대는데, 느린 러너에서 History 의 `git log` 가
// status 관측보다 먼저 끝났다. 여기의 서버는 모두 **새 store** 라 관측이 없다.

func initialRepoFake(t *testing.T, oid string) *gitHistFake {
	t.Helper()
	f := newGitHistFake(t)
	f.statusOut = "# branch.oid " + oid + "\x00# branch.head main\x00"
	// 관측은 signature 도 읽는다 — gitdir 의 HEAD 가 있어야 한다.
	if err := os.WriteFile(filepath.Join(f.gitDir, "HEAD"), []byte("ref: refs/heads/main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return f
}

// V-GEO-1: 관측 없이, `git log` 가 빈 목록으로 성공한다 — CI 트레이스의 회차 그대로.
func TestAPIGitLog_InitialWithoutObservation_EmptyList(t *testing.T) {
	f := initialRepoFake(t, "(initial)")
	s := gitHistServer(t, f)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/log?repo="+f.root, "")

	if code != http.StatusOK {
		t.Fatalf("code=%d (body %v)", code, out)
	}
	if out["initial"] != true {
		t.Fatalf("initial=%v — 관측이 오기 전의 빈 저장소를 빈 저장소라 말하지 못했다", out["initial"])
	}
}

// V-GEO-2: 관측 없이, `git log` 가 exit 128 로 실패한다 — "불러오지 못했습니다" 가 아니다.
func TestAPIGitLog_InitialWithoutObservation_Exit128(t *testing.T) {
	f := initialRepoFake(t, "(initial)")
	f.logFail = true
	s := gitHistServer(t, f)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/log?repo="+f.root, "")

	if code != http.StatusOK {
		t.Fatalf("code=%d — 빈 저장소가 실패로 떨어졌다 (FR-GDT-21) (body %v)", code, out)
	}
	if out["initial"] != true {
		t.Fatalf("initial=%v", out["initial"])
	}
}

// V-GEO-4: 커밋이 있는 저장소에서 필터가 아무것도 못 찾으면 빈 저장소가 아니다.
func TestAPIGitLog_NotInitialWhenObservationHasCommit(t *testing.T) {
	f := initialRepoFake(t, "1111111111111111111111111111111111111111")
	s := gitHistServer(t, f)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/log?repo="+f.root+"&author=nobody", "")

	if code != http.StatusOK {
		t.Fatalf("code=%d (body %v)", code, out)
	}
	if v, ok := out["initial"]; ok && v != false {
		t.Fatalf("initial=%v — 필터에 걸리는 것이 없는 것을 빈 저장소라 말했다", v)
	}
}

// V-GEO-3 · FR-GEO-3: 거부된 요청은 관측도 하지 않는다 (H-L2 가 지키는 것).
func TestAPIGitLog_RejectedDoesNotObserve(t *testing.T) {
	f := initialRepoFake(t, "(initial)")
	s := gitHistServer(t, f)

	code, _ := gitReq(t, s, http.MethodGet, "/api/git/log?repo="+f.root+"&order=reverse", "")

	if code != http.StatusBadRequest {
		t.Fatalf("code=%d want 400", code)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부했는데 실행했다: %v", f.calls())
	}
}
