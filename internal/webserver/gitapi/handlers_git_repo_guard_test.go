package gitapi

import (
	"errors"
	"net/http"
	"net/url"
	"testing"

	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/domain/git/core"
)

// FILE_API_BOUNDARY_SRS 묶음 G (FR-FAB-14·15, `SEC-15`) — `repo` 도 경계를 지난다.
//
// UI 는 등록한 저장소만 보여주지만 **API 에는 그 제약이 없었다.** 요청을 직접
// 만들면 등록하지 않은 저장소의 커밋 로그·diff 가 읽혔다. 파일 표면은 같은 길이
// 이미 막혀 있었고 git 만 열려 있었다.

// 절대경로는 OS 마다 다르다 — 리터럴을 쓰면 Windows 에서 `IsAbs` 가 거짓이고
// 판정이 403 이 아니라 400 이 된다 (WINDOWS_TEST_PARITY_SRS FR-WTP-10).
var guardOutsideRepo = testpath.Abs("elsewhere", "repo")

func denyAllExcept(allowed string) func(string) error {
	return func(p string) error {
		if p == allowed {
			return nil
		}
		return errors.New("denied")
	}
}

// TC-FAB-27: 허용 루트 밖 저장소는 403 이다.
func TestGitRepoGuard_OutsideIsForbidden(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: guardOutsideRepo + "\n"}, nil }
	s.RepoGuard = denyAllExcept(absWorkRepo)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo="+url.QueryEscape(guardOutsideRepo), "")
	if code != http.StatusForbidden {
		t.Fatalf("code=%d want 403 body=%v", code, out)
	}
}

// TC-FAB-28: 안쪽은 그대로 돈다.
func TestGitRepoGuard_InsidePasses(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	s.RepoGuard = denyAllExcept(absWorkRepo)

	code, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo="+url.QueryEscape(absWorkRepo), "")
	if code != http.StatusOK {
		t.Fatalf("code=%d want 200 body=%v", code, out)
	}
}

// TC-FAB-29: 판정 대상은 요청 문자열이 아니라 **푼 루트**다. 하위 경로나 링크로
// 같은 자리를 다르게 부를 수 있으므로, 문자열로 판정하면 우회가 남는다.
func TestGitRepoGuard_JudgesResolvedRoot(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: guardOutsideRepo + "\n"}, nil }

	var seen string
	s.RepoGuard = func(p string) error {
		seen = p
		return errors.New("denied")
	}
	gitReq(t, s, http.MethodGet, "/api/git/status?repo="+url.QueryEscape(guardOutsideRepo+"/deep/sub"), "")
	if seen != guardOutsideRepo {
		t.Fatalf("가드가 본 경로=%q want %q — 푼 루트로 판정해야 한다", seen, guardOutsideRepo)
	}
}

// TC-FAB-30: 가드가 주입되지 않은 배선은 종전대로다. 주입 없는 구성까지 막으면
// 그 자리가 통째로 선다.
func TestGitRepoGuard_NilKeepsBehavior(t *testing.T) {
	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	s.RepoGuard = nil

	code, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo="+url.QueryEscape(absWorkRepo), "")
	if code != http.StatusOK {
		t.Fatalf("code=%d want 200 body=%v", code, out)
	}
}
