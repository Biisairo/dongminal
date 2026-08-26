package git

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// R10 (V43, FR-GIT-104): **자격증명이 dongminal 을 통과하지 않는다.**
//
// 통과하지 않음을 보장하는 유일한 방법은 담을 자리를 만들지 않는 것이다. 그래서
// 이 검사는 동작이 아니라 **부재**를 고정한다 — 필드가 생기는 순간 실패한다.
//
// 검사 패턴은 **조각으로 조립한다.** 이 파일 자신이 검사 대상 문자열을 통째로
// 담으면 자기 자신을 잡는다.

// credWords 는 어디에도 있어서는 안 되는 이름들이다.
var credWords = []string{"pass" + "word", "pass" + "wd", "pass" + "phrase", "creden" + "tial"}

// remoteCredWords 는 원격 표면에만 추가로 금지되는 이름이다. undo 토큰(FR-GIT-83)이
// 저장소 전체에서는 `token` 을 쓰므로 전역 금지는 할 수 없다.
var remoteCredWords = []string{"to" + "ken", "sec" + "ret"}

// credScanDirs 는 git 표면 전부다. 한쪽만 검사하면 다른 쪽이 구멍이 된다.
var credScanDirs = []string{
	filepath.Join("internal", "git"),
	filepath.Join("internal", "server"),
}

// credRemoteFiles 는 원격 작업의 표면이다. 자격증명이 들어올 수 있는 유일한 경로다.
var credRemoteFiles = []string{
	filepath.Join("internal", "git", "job.go"),
	filepath.Join("internal", "git", "remote.go"),
	filepath.Join("internal", "server", "handlers_git_remote.go"),
}

func credPattern(words []string) *regexp.Regexp {
	return regexp.MustCompile(`(?i)` + strings.Join(words, "|"))
}

func TestNoCredentialFields(t *testing.T) {
	root := repoRootForTest(t)
	global := credPattern(credWords)
	remote := credPattern(append(append([]string{}, credWords...), remoteCredWords...))

	remoteSet := map[string]bool{}
	for _, f := range credRemoteFiles {
		remoteSet[f] = true
	}

	scanned := 0
	var offenders []string
	for _, dir := range credScanDirs {
		entries, err := os.ReadDir(filepath.Join(root, dir))
		if err != nil {
			t.Fatalf("%s: %v", dir, err)
		}
		for _, e := range entries {
			name := e.Name()
			// 테스트 파일은 건너뛴다 — 이 검사가 자기 패턴을 잡는다.
			if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			rel := filepath.Join(dir, name)
			body, err := os.ReadFile(filepath.Join(root, rel))
			if err != nil {
				t.Fatalf("%s: %v", rel, err)
			}
			scanned++
			re := global
			if remoteSet[rel] {
				re = remote
			}
			for i, line := range strings.Split(string(body), "\n") {
				if re.MatchString(line) {
					offenders = append(offenders, rel+":"+strconv.Itoa(i+1)+": "+strings.TrimSpace(line))
				}
			}
		}
	}
	// 훑은 파일이 없으면 통과가 무의미하다.
	if scanned < 40 {
		t.Fatalf("검사한 .go 파일이 %d 개뿐이다 — 탐색이 깨졌다", scanned)
	}
	// 원격 표면 파일이 실제로 존재해야 한다. 없으면 그 파일의 강한 검사가 돌지 않는다.
	for _, f := range credRemoteFiles {
		if _, err := os.Stat(filepath.Join(root, f)); err != nil {
			t.Fatalf("원격 표면 파일이 없다: %s (%v)", f, err)
		}
	}
	if len(offenders) > 0 {
		t.Fatalf("자격증명을 담는 자리가 있다 (FR-GIT-104, V43):\n%s", strings.Join(offenders, "\n"))
	}
}

// 패턴이 실제로 잡는지 확인한다 — 잡지 못하는 패턴은 위 테스트를 무의미하게 만든다.
func TestCredentialPatternMatches(t *testing.T) {
	global := credPattern(credWords)
	remote := credPattern(append(append([]string{}, credWords...), remoteCredWords...))
	hit := []string{
		"Pass" + `word string ` + "`json:\"pass" + `word"` + "`",
		"SSHPass" + `phrase string`,
		"creden" + `tialHelper string`,
	}
	for _, s := range hit {
		if !global.MatchString(s) {
			t.Fatalf("놓쳤다: %s", s)
		}
	}
	only := "Auth" + "To" + `ken string`
	if global.MatchString(only) {
		t.Fatalf("전역 패턴이 오탐했다: %s", only)
	}
	if !remote.MatchString(only) {
		t.Fatalf("원격 패턴이 놓쳤다: %s", only)
	}
	if global.MatchString("AuthRequired bool") {
		t.Fatal("오탐: AuthRequired 는 자격증명 필드가 아니다")
	}
}
