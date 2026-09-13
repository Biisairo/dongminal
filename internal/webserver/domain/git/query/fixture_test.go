package query

import (
	"dongminal/internal/shared/gittest"
	"os"
	"path/filepath"
	"testing"
)

// 실제 git 을 쓰는 테스트의 공용 픽스처다. core 의 같은 헬퍼를 복제한 것이며,
// 테스트 헬퍼는 패키지 경계를 넘지 못하므로 다른 길이 없다.

// tempRepoWithBranch 는 커밋 하나 + 추가 브랜치 하나인 저장소다.
func tempRepoWithBranch(t *testing.T, branch string) string {
	t.Helper()
	repo := tempRepo(t)
	gitRun(t, repo, "branch", branch)
	return repo
}

func writeFile(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func gitPath(t *testing.T) string { return gittest.Path(t) }

// tempRepo 는 커밋 하나를 가진 임시 저장소다 (`gittest.Repo`, M8 D-A-20).
func tempRepo(t *testing.T) string { return gittest.Repo(t) }

// gitRun 은 준비 단계의 git 이다. 이 패키지의 진입점을 쓰지 않는 이유는 준비에
// 필요한 명령(remote add·push)이 허용 목록에 없기 때문이다.
func gitRun(t *testing.T, dir string, args ...string) { gittest.Run(t, dir, args...) }
