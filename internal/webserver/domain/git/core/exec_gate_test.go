package core

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// 실행 층의 게이트 (GIT_EXEC_UNIFY_SRS §3.4, 검증 V11~V16).
//
// `static_test.go` 의 `TestNoDirectGitExecOutsidePackage` 는 **인자 자리의 리터럴
// `"git"`** 을 찾는다. 그 기준으로는 아래 형태를 잡지 못한다:
//
//	bin, err := exec.LookPath("git")
//	cmd := exec.CommandContext(ctx, bin, args...)
//
// 그리고 이 저장소의 git 실행은 **전부** 그 형태였다 — 다섯 자리 중 하나도 검사에
// 걸리지 않았고, 그래서 셋이 `Env()` 없이 자랐다. 정규식을 변수까지 넓히는 것은
// 답이 아니다: `bin` 은 `rg`·`docker` 이기도 하다 (그 사실이 기존 테스트의 miss
// 표본에 박혀 있다).
//
// **기준을 바꾼다.** git 을 띄우려면 반드시 `LookPath("git")` 을 지나므로, 그것을
// 세면 오탐 없이 전부 잡힌다.

// 검사 패턴은 조각으로 조립한다 — 이 파일 자신이 검사 대상 문자열을 통째로
// 담으면 자기 자신을 잡는다 (static_test.go 와 같은 규약).
var gitLookPath = regexp.MustCompile(`exec\.` + `LookPath\(` + gitLiteral + `\)`)

// unguardedCall 은 인가를 건너뛰는 진입점의 **호출**만 잡는다. 주석 안의 이름은
// 괄호가 없으므로 걸리지 않는다.
var unguardedCall = regexp.MustCompile(`\.` + `ExecUnguarded\(`)

// envLiteral 은 실행 환경 규약을 지나는지 보는 표식이다. core 안에서는 `Env()`,
// 밖에서는 `core.Env()` 이므로 접미만 본다.
const envLiteral = `En` + `v()`

// gitBinAllowed 는 **git 바이너리를 얻어도 되는 자리**다.
//
// 하나뿐인 것이 이 SRS 의 결과다 (NFR-GXU-3). 다른 곳이 git 을 띄워야 한다면
// 그것은 `ExecUnguarded` 를 부르는 것이지 바이너리를 직접 찾는 것이 아니다.
var gitBinAllowed = []string{
	filepath.Join("internal", "webserver", "domain", "git"),
}

// unguardedAllowed 는 인가를 건너뛰는 진입점을 **부를 수 있는 자리**다
// (FR-GXU-12). 이 목록이 이 설계의 안전 장치 전부다 — `ExecUnguarded` 는
// 화이트리스트를 지나지 않으므로, 누가 부를 수 있는지가 고정되지 않으면
// `readCommands`·`writeCommands` 가 뜻을 잃는다.
//
// 앞의 둘은 디렉터리, 마지막은 파일 하나다. `httpapi` 전체를 여는 것은 그 패키지의
// 다른 파일에 인가 우회를 허가하는 뜻이다.
var unguardedAllowed = []string{
	// FR-GIT-246 — `git worktree` 는 한 하위 명령에 list(읽기)와 add(쓰기)를
	// 함께 갖고, 허용 목록은 argv[0] 으로만 키잉된다. 어느 목록에 넣어도
	// 교집합-금지 불변식이 뜻을 잃는다.
	filepath.Join("internal", "webserver", "domain", "worktree"),
	// UX_BATCH5_SRS D-9 — submodule status/update 가 같은 상황이다.
	filepath.Join("internal", "webserver", "domain", "submodule"),
	// check-ignore 는 readCommands 에 없다. 넣는 것은 화이트리스트 확장이며
	// 그것은 비목표다 (§5 N1).
	filepath.Join("internal", "webserver", "httpapi", "handlers_fs_ignored.go"),
}

// goFilesUnderRepo 는 검사 대상 .go 파일을 훑는다. 훑은 수가 하한 미만이면
// 실패시킨다 (FR-GXU-16) — 탐색이 깨졌을 때 "위반 0건" 은 통과가 아니다.
func goFilesUnderRepo(t *testing.T, visit func(rel string, body string)) {
	t.Helper()
	root := repoRootForTest(t)
	scanned := 0
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			// `.claude` 아래의 worktree 는 **이 저장소의 사본**이지 소스가 아니다
			// (static_test.go 와 같은 근거).
			case "node_modules", ".git", ".claude", "e2e":
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
		body, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		scanned++
		visit(rel, string(body))
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if scanned < 20 {
		t.Fatalf("검사한 .go 파일이 %d 개뿐이다 — 탐색이 깨졌다", scanned)
	}
}

func underAny(rel string, allowed []string) bool {
	for _, ex := range allowed {
		if rel == ex || strings.HasPrefix(rel, ex+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// V16 (FR-GXU-11, NFR-GXU-3): git 바이너리를 얻는 자리가 domain/git 밖에 없다.
//
// 종전 게이트가 못 보던 형태이며, 이 저장소의 git 실행 다섯 자리가 **전부** 이
// 형태였다.
func TestGitBinaryLookupIsConfinedToDomain(t *testing.T) {
	var offenders []string
	goFilesUnderRepo(t, func(rel, body string) {
		if underAny(rel, gitBinAllowed) || strings.HasSuffix(rel, "_test.go") {
			return
		}
		for i, line := range strings.Split(body, "\n") {
			if gitLookPath.MatchString(line) {
				offenders = append(offenders, rel+":"+strconv.Itoa(i+1)+": "+strings.TrimSpace(line))
			}
		}
	})
	if len(offenders) > 0 {
		t.Fatalf(`git 바이너리를 domain/git 밖에서 찾는다 (GIT_EXEC_UNIFY_SRS FR-GXU-11).

고치는 길: 그 자리는 프로세스를 직접 띄우지 말고 core 의 실행 층을 쓴다.
  · 화이트리스트를 지나는 실행이면  Service.Exec / Service.ExecWrite
  · 도메인이 자기 인가를 지는 실행이면  Service.ExecUnguarded (호출처 등록 필요)

%s`, strings.Join(offenders, "\n"))
	}
}

// V11 (FR-GXU-11): 패턴이 잡아야 할 것과 잡지 말아야 할 것.
// 잡지 못하는 패턴은 위 테스트를 무의미하게 만들고, 오탐은 개발을 막는다.
func TestGitLookPathPatternMatches(t *testing.T) {
	hit := []string{
		`bin, err := exec.` + `LookPath(` + gitLiteral + `)`,
		`p, _ := exec.` + `LookPath(` + gitLiteral + `)`,
	}
	for _, s := range hit {
		if !gitLookPath.MatchString(s) {
			t.Fatalf("놓쳤다: %s", s)
		}
	}
	// 다른 바이너리는 이 게이트의 대상이 아니다 — 이 저장소는 rg·docker 도 띄운다.
	miss := []string{
		`p, err := exec.` + `LookPath("rg")`,
		`func LookPath(name string) (string, error) { return exec.` + `LookPath(name) }`,
		`out, _ := exec.` + `LookPath("gitk")`,
	}
	for _, s := range miss {
		if gitLookPath.MatchString(s) {
			t.Fatalf("오탐: %s", s)
		}
	}
}

// V12 (FR-GXU-12): 인가를 건너뛰는 진입점의 호출처가 고정돼 있다.
//
// **이 검사가 이 설계의 안전 장치 전부다.** ExecUnguarded 는 화이트리스트를
// 지나지 않으므로, 아무나 부를 수 있으면 readCommands·writeCommands 가 뜻을 잃는다.
func TestExecUnguardedCallersAreConfined(t *testing.T) {
	var offenders []string
	goFilesUnderRepo(t, func(rel, body string) {
		// 정의한 자리와 그 시험은 대상이 아니다.
		if underAny(rel, gitBinAllowed) || strings.HasSuffix(rel, "_test.go") {
			return
		}
		if underAny(rel, unguardedAllowed) {
			return
		}
		for i, line := range strings.Split(body, "\n") {
			if unguardedCall.MatchString(line) {
				offenders = append(offenders, rel+":"+strconv.Itoa(i+1)+": "+strings.TrimSpace(line))
			}
		}
	})
	if len(offenders) > 0 {
		t.Fatalf(`인가를 지나지 않는 실행을 허용되지 않은 자리에서 부른다 (FR-GXU-12).

ExecUnguarded 는 명령 화이트리스트를 지나지 않는다. 부르려면 그 자리가 **자기
인가**를 지고 있어야 하고, 그 사실이 이 목록에 근거와 함께 등록돼야 한다.
대개는 Service.Exec / Service.ExecWrite 가 옳은 답이다.

%s`, strings.Join(offenders, "\n"))
	}
}

// V13 (FR-GXU-13): 허용 목록에 **죽은 예외**가 없다. 목록이 사실과 다르면 그것을
// 읽는 사람이 틀린 그림을 얻는다 — 이 저장소는 실제로 그랬다 (worktree 가 예외로
// 등록돼 있었으나 애초에 검사되지도 않았고, submodule 은 목록에 없이 통과했다).
func TestExecAllowlistsHaveNoDeadEntries(t *testing.T) {
	root := repoRootForTest(t)

	// 등록된 경로는 실재해야 한다.
	for _, list := range [][]string{gitBinAllowed, unguardedAllowed, execAllowed} {
		for _, ex := range list {
			if _, err := os.Stat(filepath.Join(root, ex)); err != nil {
				t.Fatalf("허용 목록의 %q 가 실재하지 않는다: %v", ex, err)
			}
		}
	}

	// 등록된 예외는 실제로 쓰여야 한다 — 쓰이지 않는 예외는 "여기서는 규약을
	// 어겨도 된다"는 잘못된 신호로 남는다.
	used := map[string]bool{}
	goFilesUnderRepo(t, func(rel, body string) {
		if strings.HasSuffix(rel, "_test.go") {
			return
		}
		for _, ex := range unguardedAllowed {
			if underAny(rel, []string{ex}) && unguardedCall.MatchString(body) {
				used[ex] = true
			}
		}
	})
	for _, ex := range unguardedAllowed {
		if !used[ex] {
			t.Fatalf("%q 가 ExecUnguarded 허용 목록에 있으나 부르지 않는다 — 죽은 예외다", ex)
		}
	}
}

// V14 (FR-GXU-14): git 을 띄우는 파일은 환경 규약을 지난다.
//
// FR-GXU-7 만 하고 이 검사를 두지 않으면 **다음에 추가되는 자리가 같은 방식으로
// 빠진다.** 규약은 선언으로 지켜지지 않는다 (check-seams.sh 의 주석과 같은 근거).
func TestGitExecSitesPassEnvContract(t *testing.T) {
	var offenders []string
	goFilesUnderRepo(t, func(rel, body string) {
		if strings.HasSuffix(rel, "_test.go") || !gitLookPath.MatchString(body) {
			return
		}
		if !strings.Contains(body, envLiteral) {
			offenders = append(offenders, rel)
		}
	})
	if len(offenders) > 0 {
		t.Fatalf(`git 을 띄우면서 환경 규약을 지나지 않는다 (FR-GXU-14).

cmd.Env = core.Env() 를 붙여라. 그것이 프롬프트·askpass·페이저·편집기가 없는
자리에서 git 이 매달리지 않게 하고(FR-GIT-104), index.lock 경합과 로케일 흔들림을
막는다.

%s`, strings.Join(offenders, "\n"))
	}
}

// V18 (GIT_EXEC_UNIFY_SRS §5 N1): 실행 층을 공유해도 **인가 층은 늘지 않는다.**
//
// 이 SRS 의 핵심 약속이다. `worktree`·`submodule`·`check-ignore` 를 허용 목록에
// 넣는 것은 FR-GIT-246 과 D-9 가 두 번에 걸쳐 기각한 안이며, 그 기각은 지금도
// 옳다 — 셋 다 한 하위 명령에 읽기와 쓰기를 함께 갖거나(worktree·submodule)
// 이 표면이 제공하지 않는 동작이다(check-ignore).
//
// 숫자를 못박는 이유는 "하나쯤" 이 쌓이는 것을 막기 위해서다. 목록을 늘리려면
// 이 상수를 함께 고쳐야 하고, 그 diff 가 리뷰에 보인다.
func TestCommandAllowlistsDidNotGrow(t *testing.T) {
	const (
		wantRead  = 15
		wantWrite = 22
	)
	if len(readCommands) != wantRead {
		t.Fatalf("readCommands 가 %d 개다 (기대 %d) — 허용 목록이 바뀌었다면 근거 문서를 함께 고쳐라 (FR-GIT-7)", len(readCommands), wantRead)
	}
	if len(writeCommands) != wantWrite {
		t.Fatalf("writeCommands 가 %d 개다 (기대 %d) — 허용 목록이 바뀌었다면 근거 문서를 함께 고쳐라 (FR-GIT-95)", len(writeCommands), wantWrite)
	}
	// 이 SRS 가 실행 층만 공유한다는 사실을 이름으로도 못박는다.
	for _, name := range []string{"worktree", "submodule", "check-ignore"} {
		if readCommands[name] || writeCommands[name] {
			t.Fatalf("%q 가 허용 목록에 들어갔다 — GIT_EXEC_UNIFY_SRS §5 N1 위반 (FR-GIT-246 · D-9)", name)
		}
	}
}
