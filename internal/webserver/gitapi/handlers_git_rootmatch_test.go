package gitapi

import (
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 루트 판정 (GIT_DIR_ENTRY_SRS FR-DIR-5·42 / D-DIR-6).
//
// **비교는 정규화를 아는 쪽이 한다.** `requested` 는 클라이언트가 보낸 값 그대로고
// `repo` 는 git 이 심볼릭 링크를 푼 값이라, 클라이언트가 그 둘을 문자열로 비교하면
// macOS 의 `/tmp` 같은 경로에서 반드시 어긋난다.

// V-DIR-6: 저장소 루트로 물으면 참, 그 하위로 물으면 거짓이다.
func TestGitStatus_RootMatch(t *testing.T) {
	for _, tc := range []struct {
		name string
		ask  string
		want bool
	}{
		{"루트", absWorkRepo, true},
		{"하위", absWorkRepoSub, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			g := newGitFake(t)
			s, _, _, _ := gitTestServer(t, g)
			g.root = func(string) (core.Output, error) { return core.Output{Stdout: absWorkRepo + "\n"}, nil }

			code, out := gitReq(t, s, http.MethodGet,
				"/api/git/status?repo="+url.QueryEscape(tc.ask), "")
			if code != http.StatusOK {
				t.Fatalf("code=%d body=%v", code, out)
			}
			if out["rootMatch"] != tc.want {
				t.Fatalf("rootMatch=%v, want %v", out["rootMatch"], tc.want)
			}
			// 접두 계산의 근거다 (FR-DIR-41) — 없으면 하위 루트의 색이 어긋난다.
			if out["requestedResolved"] == nil {
				t.Fatalf("requestedResolved 가 없다: %v", out)
			}
		})
	}
}

// V-DIR-7: 심볼릭 링크가 낀 경로로 물어도 참이다. 이것이 §2.5 의 회귀 검사다 —
// 고치기 전에는 `/tmp/…` 로 연 Editor 의 색이 영구히 꺼졌다.
func TestGitStatus_RootMatchThroughSymlink(t *testing.T) {
	base := t.TempDir()
	real := filepath.Join(base, "real")
	if err := os.MkdirAll(real, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("심볼릭 링크를 만들 수 없다: %v", err)
	}
	// git 은 링크를 푼 값을 준다 — 실측에서 확인한 동작이다.
	resolved, err := filepath.EvalSymlinks(real)
	if err != nil {
		t.Fatalf("EvalSymlinks: %v", err)
	}

	g := newGitFake(t)
	s, _, _, _ := gitTestServer(t, g)
	g.root = func(string) (core.Output, error) { return core.Output{Stdout: resolved + "\n"}, nil }

	code, out := gitReq(t, s, http.MethodGet, "/api/git/status?repo="+url.QueryEscape(link), "")
	if code != http.StatusOK {
		t.Fatalf("code=%d body=%v", code, out)
	}
	if out["rootMatch"] != true {
		t.Fatalf("rootMatch=%v, want true (repo=%v requested=%v)",
			out["rootMatch"], out["repo"], out["requested"])
	}
	if out["requested"] != link {
		t.Fatalf("requested=%v, want %v (보낸 값 그대로여야 한다)", out["requested"], link)
	}
}
