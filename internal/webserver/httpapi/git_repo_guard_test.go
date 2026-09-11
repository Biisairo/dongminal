package httpapi

import (
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/webserver/domain/wsentry"
)

// FILE_API_BOUNDARY_SRS FR-FAB-14·15 (`SEC-15`) — git 의 `repo` 가 지나는 경계.
//
// 판정은 파일 표면의 것을 그대로 쓴다. 여기서 확인하는 것은 **그 재사용이
// 실제로 일어나는가**다 — 같은 루트, 같은 예외.

func TestGitRepoAllowed_InsideRoot(t *testing.T) {
	e := newFileBoundaryEnv(t)
	srv := e.server
	repo := filepath.Join(e.root, "proj-a")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := srv.gitRepoAllowed(repo); err != nil {
		t.Fatalf("Editor 루트 아래 저장소가 막혔다: %v", err)
	}
}

// **핀으로 등록한 저장소는 어디에 있든 통과한다** (FR-FAB-14a).
//
// 이 검사가 없어서 e2e 전량이 한 번에 깨졌다 — `Roots()` 는 `Editors` 만 담는데
// git 에서 "워크스페이스에 등록" 이란 곧 **핀**이다.
func TestGitRepoAllowed_PinnedRepoPasses(t *testing.T) {
	e := newFileBoundaryEnv(t)
	repo := filepath.Join(e.outside, "pinned-repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := e.server.Entries.Mutate(func(cur wsentry.Lists) wsentry.Lists {
		cur.Pinned = append(cur.Pinned, repo)
		return cur
	}); err != nil {
		t.Fatalf("핀 등록: %v", err)
	}
	if err := e.server.gitRepoAllowed(repo); err != nil {
		t.Fatalf("핀으로 등록한 저장소가 막혔다: %v", err)
	}
	// 그 안쪽도 통과해야 한다 — 서브모듈이 그 자리다.
	sub := filepath.Join(repo, "sub")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := e.server.gitRepoAllowed(sub); err != nil {
		t.Fatalf("핀 저장소 안쪽이 막혔다: %v", err)
	}
}

// TC-FAB-32: 등록 경로의 **조상** 저장소도 통과한다 (FR-FAB-14b).
//
// 저장소 안의 하위 폴더를 Editor 루트로 삼는 것이 정상이고(`FR-DIR-40`), 그때 다룰
// 저장소는 그 루트의 조상이다. 아래쪽만 보면 그 흐름이 통째로 끊긴다 — e2e 전량이
// 그 사실을 보고했다.
func TestGitRepoAllowed_AncestorRepoPasses(t *testing.T) {
	e := newFileBoundaryEnv(t)
	// e.root 는 Editor 루트다. 그 **부모**를 저장소 루트로 본다.
	parent := filepath.Dir(e.root)
	if err := e.server.gitRepoAllowed(parent); err != nil {
		t.Fatalf("등록 경로의 조상 저장소가 막혔다: %v", err)
	}
}

func TestGitRepoAllowed_OutsideRootIsDenied(t *testing.T) {
	e := newFileBoundaryEnv(t)
	repo := filepath.Join(e.outside, "secret-repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := e.server.gitRepoAllowed(repo); err == nil {
		t.Fatal("아무 목록에도 없는 저장소가 통과했다")
	}
}

// 예외도 같다 — 규칙이 둘이면 한쪽만 고쳐지고, 그때 "탐색기에서는 열리는데 git 은
// 안 된다" 가 된다 (FR-FAB-15).
func TestGitRepoAllowed_UnrestrictedPasses(t *testing.T) {
	e := newFileBoundaryEnvWith(t, func(data string) {
		p := filepath.Join(data, "settings.json")
		if err := os.WriteFile(p, []byte(`{"fileApiUnrestricted":true}`), 0o644); err != nil {
			t.Fatal(err)
		}
	})
	repo := filepath.Join(e.outside, "anywhere")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := e.server.gitRepoAllowed(repo); err != nil {
		t.Fatalf("경계가 꺼져 있는데 막혔다: %v", err)
	}
}
