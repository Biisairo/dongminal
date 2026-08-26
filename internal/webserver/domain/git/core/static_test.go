package core

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// 검사 패턴과 표본은 **조각으로 조립한다.** 이 파일 자신이 검사 대상 문자열을
// 통째로 담으면 자기 자신을 잡는다.
const gitLiteral = `"gi` + `t"`

var directExec = regexp.MustCompile(`exec\.` + `Command(Context)?\([^)]*` + gitLiteral)

// 허용 예외는 FR-GIT-1 이 명시한 두 곳뿐이다 — internal/worktree 는 Run 격리 전용
// 경로이고, internal/webserver/domain/git 자신이 그 단일 지점이다.
var execAllowed = []string{
	filepath.Join("internal", "webserver", "domain", "worktree"),
	filepath.Join("internal", "webserver", "domain", "git"),
}

// V1 (FR-GIT-1): 저장소의 다른 곳에서 git 을 직접 실행하지 않는다.
func TestNoDirectGitExecOutsidePackage(t *testing.T) {
	root := repoRootForTest(t)
	scanned := 0
	var offenders []string

	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "node_modules", ".git", "e2e":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") {
			return nil
		}
		rel, rerr := filepath.Rel(root, path)
		if rerr != nil {
			return rerr
		}
		for _, ex := range execAllowed {
			if strings.HasPrefix(rel, ex+string(filepath.Separator)) {
				return nil
			}
		}
		scanned++
		body, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		for i, line := range strings.Split(string(body), "\n") {
			if directExec.MatchString(line) {
				offenders = append(offenders, rel+":"+strconv.Itoa(i+1)+": "+strings.TrimSpace(line))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	// 훑은 파일이 없으면 통과가 무의미하다.
	if scanned < 20 {
		t.Fatalf("검사한 .go 파일이 %d 개뿐이다 — 탐색이 깨졌다", scanned)
	}
	if len(offenders) > 0 {
		t.Fatalf("webserver/domain/git 밖에서 git 을 직접 실행한다 (FR-GIT-1):\n%s", strings.Join(offenders, "\n"))
	}
}

// 패턴이 실제로 잡는지 확인한다 — 잡지 못하는 패턴은 위 테스트를 무의미하게 만든다.
func TestDirectExecPatternMatches(t *testing.T) {
	hit := []string{
		`cmd := exec.` + `Command(` + gitLiteral + `, "status")`,
		`out, err := exec.` + `CommandContext(ctx, ` + gitLiteral + `, "log").Output()`,
	}
	for _, s := range hit {
		if !directExec.MatchString(s) {
			t.Fatalf("놓쳤다: %s", s)
		}
	}
	miss := []string{
		`cmd := exec.` + `Command(bin, args...)`,
		`cmd := exec.` + `CommandContext(ctx, bin, args...)`,
		`out, _ := exec.` + `Command("gitk").Output()`,
	}
	for _, s := range miss {
		if directExec.MatchString(s) {
			t.Fatalf("오탐: %s", s)
		}
	}
}

func repoRootForTest(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, serr := os.Stat(filepath.Join(dir, "go.mod")); serr == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod 를 찾을 수 없다 — 저장소 루트를 확정하지 못했다")
		}
		dir = parent
	}
}
