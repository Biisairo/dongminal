package query

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/gittest"
	"dongminal/internal/webserver/domain/git/core"
)

// REPO_FIX 01 §7.6 — diff 의 심링크·서브모듈·대용량.

// 추적 중인 심링크의 대상을 바꾸면 양쪽 모두 **링크 문자열**이다. 종전에는 작업
// 트리 쪽만 링크를 따라가 대상 파일 본문을 보여 전체가 바뀐 것처럼 보였다.
func TestDiffContent_TrackedSymlinkComparesLinkText(t *testing.T) {
	repo := tempRepo(t)
	diffWrite(t, repo, "real.txt", "REAL\n")
	diffWrite(t, repo, "other.txt", "OTHER\n")
	if err := os.Symlink("real.txt", filepath.Join(repo, "in")); err != nil {
		t.Skipf("심링크를 만들 수 없다: %v", err)
	}
	gitIn(t, repo, "add", "real.txt", "other.txt", "in")
	gitIn(t, repo, "commit", "-q", "-m", "link")
	if err := os.Remove(filepath.Join(repo, "in")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("other.txt", filepath.Join(repo, "in")); err != nil {
		t.Fatal(err)
	}
	dc, err := DiffContentOf(core.New(), context.Background(), repo, AxisWorktreeHead, "in", "")
	if err != nil {
		t.Fatalf("DiffContentOf: %v", err)
	}
	if dc.Original.Content != "real.txt" || dc.Modified.Content != "other.txt" {
		t.Fatalf("양쪽 = %q / %q, want 링크 문자열", dc.Original.Content, dc.Modified.Content)
	}
}

func addSubmoduleCommit(t *testing.T) (repo, oid, parent string) {
	t.Helper()
	sub := tempRepo(t)
	// 두 픽스처 저장소의 첫 커밋은 oid 가 같다 — 그대로면 상위 저장소에 서브모듈의
	// 커밋 객체가 있는 드문 경우(한계로 명시)가 된다. 서브모듈 쪽을 한 번 더 커밋한다.
	diffWrite(t, sub, "own.txt", "own\n")
	gitIn(t, sub, "add", "own.txt")
	gitIn(t, sub, "commit", "-q", "-m", "own")
	repo = tempRepo(t)
	cmd := exec.Command("git", "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub")
	cmd.Dir = repo
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Skipf("submodule add 실패: %v %s", err, out)
	}
	gitIn(t, repo, "commit", "-q", "-m", "add sub")
	parent = strings.TrimSpace(gittest.Run(t, repo, "rev-parse", "HEAD"))
	diffWrite(t, sub, "more.txt", "m\n")
	gitIn(t, sub, "add", "more.txt")
	gitIn(t, sub, "commit", "-q", "-m", "more")
	gitIn(t, filepath.Join(repo, "sub"), "-c", "protocol.file.allow=always", "pull", "-q", "origin", "HEAD")
	gitIn(t, repo, "add", "sub")
	gitIn(t, repo, "commit", "-q", "-m", "bump sub")
	oid = strings.TrimSpace(gittest.Run(t, repo, "rev-parse", "HEAD"))
	return repo, oid, parent
}

// §7.6: History 에서 서브모듈 포인터 변경을 누르면 500 이었다(`cat-file -s
// <oid>:sub` → could not get object info). 양쪽이 submodule 과 커밋 oid 로 온다.
func TestDiffCommit_SubmodulePointerIsSubmoduleKind(t *testing.T) {
	repo, oid, parent := addSubmoduleCommit(t)
	dc, err := DiffCommit(core.New(), context.Background(), repo, oid, parent, "sub", "")
	if err != nil {
		t.Fatalf("DiffCommit: %v", err)
	}
	if dc.Original.Kind != DiffKindSubmodule || dc.Modified.Kind != DiffKindSubmodule {
		t.Fatalf("kind = %q / %q", dc.Original.Kind, dc.Modified.Kind)
	}
	if len(dc.Original.Oid) != 40 || len(dc.Modified.Oid) != 40 || dc.Original.Oid == dc.Modified.Oid {
		t.Fatalf("oid = %q / %q", dc.Original.Oid, dc.Modified.Oid)
	}
}

// §7.6: 작업 트리 쪽은 서브모듈 디렉터리이고 반대쪽이 submodule 이면 작업 트리
// 쪽도 submodule 이다.
func TestDiffContent_WorktreeSubmoduleDir(t *testing.T) {
	repo, _, _ := addSubmoduleCommit(t)
	dc, err := DiffContentOf(core.New(), context.Background(), repo, AxisWorktreeHead, "sub", "")
	if err != nil {
		t.Fatalf("DiffContentOf: %v", err)
	}
	if dc.Original.Kind != DiffKindSubmodule || dc.Modified.Kind != DiffKindSubmodule {
		t.Fatalf("kind = %q / %q", dc.Original.Kind, dc.Modified.Kind)
	}
}

// §7.6: 작업 트리 그림 본문은 상한을 넘으면 읽지 않고 ErrDiffTooLarge 다. 종전에는
// 크기 검사 없이 os.ReadFile 로 수 GB 파일도 통째로 읽었다.
func TestSideBytes_WorktreeOverCapIsTooLarge(t *testing.T) {
	repo := tempRepo(t)
	diffWrite(t, repo, "big.bin", strings.Repeat("x", 100))
	img := core.New(core.WithMaxOutput(10))
	_, err := SideBytes(img, context.Background(), repo, AxisWorktreeHead, "big.bin", "", "", "", DiffSideModified)
	if !errors.Is(err, ErrDiffTooLarge) {
		t.Fatalf("err = %v, want ErrDiffTooLarge", err)
	}
}

// §7.6: 작업 트리 쪽이 심링크면 SideBytes 도 링크를 따라가지 않는다(밖의 파일을
// 내보내지 않는다).
func TestSideBytes_WorktreeSymlinkIsLinkText(t *testing.T) {
	outside := tempRepo(t)
	diffWrite(t, outside, "secret.png", "SECRET")
	repo := tempRepo(t)
	if err := os.Symlink(filepath.Join(outside, "secret.png"), filepath.Join(repo, "l.png")); err != nil {
		t.Skipf("심링크를 만들 수 없다: %v", err)
	}
	b, err := SideBytes(core.New(), context.Background(), repo, AxisWorktreeHead, "l.png", "", "", "", DiffSideModified)
	if err != nil {
		t.Fatalf("SideBytes: %v", err)
	}
	if string(b) == "SECRET" {
		t.Fatal("심링크를 따라가 밖의 파일을 내보냈다")
	}
}
