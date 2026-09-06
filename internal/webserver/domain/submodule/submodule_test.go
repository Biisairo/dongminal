package submodule

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"dongminal/internal/shared/testpath"
)

// repoPath 는 이 호스트의 **OS 형태 절대경로**다.
//
// `"/repo"` 리터럴을 쓰면 Windows 에서 `filepath.IsAbs` 가 거짓이라 `checkRepo`
// 가 전부 거부한다 — CI 가 그렇게 깨졌다. `testpath` 가 정확히 이것을 위해 있다
// (WINDOWS_TEST_PARITY_SRS FR-WTP-10·11).
var repoPath = testpath.Abs("repo")

// UX_BATCH5_SRS 묶음 D — 서브모듈 목록과 조작 (FR-SUB-1~5).
//
// Runner 를 주입해 git 없이 파싱과 가드 전량을 시험한다 — worktree 패키지와 같은
// 규약이다 (D-9a).

func mgr(out string, err error) (*Manager, *[][]string) {
	var calls [][]string
	m := New(func(dir string, args ...string) (string, error) {
		calls = append(calls, append([]string{dir}, args...))
		return out, err
	})
	return m, &calls
}

func TestListParsesFourStates(t *testing.T) {
	// FR-SUB-2: 접두 문자가 상태다. 넷을 한 번에 본다 — 하나씩 시험하면 어느
	// 조합에서 파싱이 어긋나는지 드러나지 않는다.
	out := strings.Join([]string{
		" 8bb349bdc9845ed61fad4b60564ce257d8407e37 vendor/ok (heads/main)",
		"-1111111111111111111111111111111111111111 vendor/uninit",
		"+2222222222222222222222222222222222222222 vendor/moved (v1.0-2-gabcdef)",
		"U3333333333333333333333333333333333333333 vendor/conflicted",
	}, "\n")
	m, _ := mgr(out, nil)
	got, err := m.List(repoPath)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	want := []Entry{
		{Path: "vendor/ok", OID: "8bb349bdc9845ed61fad4b60564ce257d8407e37", State: StateOK, Describe: "heads/main"},
		{Path: "vendor/uninit", OID: "1111111111111111111111111111111111111111", State: StateUninitialized},
		{Path: "vendor/moved", OID: "2222222222222222222222222222222222222222", State: StateModified, Describe: "v1.0-2-gabcdef"},
		{Path: "vendor/conflicted", OID: "3333333333333333333333333333333333333333", State: StateConflict},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("List =\n%#v\nwant\n%#v", got, want)
	}
}

func TestListHandlesPathWithSpaces(t *testing.T) {
	// 경로에 공백이 있어도 describe 는 **끝**에 온다. 공백으로 자르면 경로가 잘린다.
	m, _ := mgr(" 4444444444444444444444444444444444444444 vendor/my lib (heads/main)", nil)
	got, err := m.List(repoPath)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 || got[0].Path != "vendor/my lib" {
		t.Fatalf("path = %#v", got)
	}
	if got[0].Describe != "heads/main" {
		t.Errorf("describe = %q", got[0].Describe)
	}
}

func TestListEmptyIsNotAnError(t *testing.T) {
	// 서브모듈이 없는 저장소는 흔하다 — 빈 출력은 정상이다. 오류로 바꾸면 탭이
	// 저장소마다 실패를 보인다 (FR-SUB-10).
	m, _ := mgr("", nil)
	got, err := m.List(repoPath)
	if err != nil {
		t.Fatalf("빈 목록이 오류가 됐다: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("len = %d, want 0", len(got))
	}
}

func TestListRejectsGarbageLine(t *testing.T) {
	// 알아보지 못한 줄은 **버린다.** 반쯤 채운 항목을 만들면 화면이 빈 경로의
	// 행을 그리고, 그 행의 동작이 저장소 전체를 가리킨다.
	m, _ := mgr(" short-oid vendor/x\n\n 5555555555555555555555555555555555555555 vendor/ok (m)", nil)
	got, err := m.List(repoPath)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 || got[0].Path != "vendor/ok" {
		t.Errorf("got = %#v", got)
	}
}

func TestListUsesStatusSubcommand(t *testing.T) {
	// FR-SUB-3: `--recursive` 를 쓰지 않는다 — 깊이를 섞으면 어느 행이 누구의
	// 것인지 말할 수 없다. 중첩은 그 서브모듈을 저장소로 연 뒤 그 창에서 본다.
	m, calls := mgr("", nil)
	if _, err := m.List(repoPath); err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(*calls) != 1 {
		t.Fatalf("호출 %d 회", len(*calls))
	}
	got := (*calls)[0]
	if got[0] != repoPath {
		t.Errorf("dir = %q", got[0])
	}
	if got[1] != "submodule" || got[2] != "status" {
		t.Errorf("argv = %v, want submodule status …", got[1:])
	}
	for _, a := range got {
		if a == "--recursive" {
			t.Error("--recursive 를 붙였다 (FR-SUB-3)")
		}
	}
}

func TestListPropagatesFailure(t *testing.T) {
	// 실패를 빈 목록으로 낮추지 않는다 — "서브모듈이 없다" 와 "확인에 실패했다" 는
	// 사용자가 할 일이 다르다 (RepoRoot 의 ErrNotRepo 와 같은 근거).
	m, _ := mgr("fatal: not a git repository", errors.New("exit status 128"))
	if _, err := m.List(repoPath); err == nil {
		t.Fatal("실패가 오류로 오지 않았다")
	}
}

func TestUpdateArgv(t *testing.T) {
	// FR-SUB-4: `init` 과 `recursive` 가 인자에 반영된다. 경로는 `--` 뒤다 —
	// 경로가 플래그로 읽히면 대상이 뜻하지 않게 넓어진다.
	for _, tc := range []struct {
		name              string
		init, recursive   bool
		path              string
		wantHas, wantNone []string
	}{
		{"plain", false, false, "vendor/x",
			[]string{"submodule", "update", "--", "vendor/x"}, []string{"--init", "--recursive"}},
		{"init", true, false, "vendor/x",
			[]string{"submodule", "update", "--init", "--", "vendor/x"}, []string{"--recursive"}},
		{"both", true, true, "vendor/x",
			[]string{"submodule", "update", "--init", "--recursive", "--", "vendor/x"}, nil},
		// FR-SUB-4: 경로가 비면 저장소의 서브모듈 **전부**가 대상이다. 그때는
		// `--` 도 붙이지 않는다 — 뒤에 올 것이 없다.
		{"all", true, false, "",
			[]string{"submodule", "update", "--init"}, []string{"--"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, calls := mgr("", nil)
			if err := m.Update(repoPath, tc.path, tc.init, tc.recursive); err != nil {
				t.Fatalf("Update: %v", err)
			}
			args := (*calls)[0][1:]
			argv := strings.Join(args, " ")
			if !strings.Contains(argv, strings.Join(tc.wantHas, " ")) {
				t.Errorf("argv = %q, want to contain %q", argv, strings.Join(tc.wantHas, " "))
			}
			// **토큰 단위로 본다.** 문자열 포함으로 보면 `--init` 이 `--` 를 품어
			// 오탐한다 — 인자는 문자열이 아니라 목록이다.
			for _, no := range tc.wantNone {
				for _, a := range args {
					if a == no {
						t.Errorf("argv = %v, must not contain token %q", args, no)
					}
				}
			}
		})
	}
}

func TestSyncArgv(t *testing.T) {
	m, calls := mgr("", nil)
	if err := m.Sync(repoPath, "vendor/x"); err != nil {
		t.Fatalf("Sync: %v", err)
	}
	argv := strings.Join((*calls)[0][1:], " ")
	if !strings.Contains(argv, "submodule sync -- vendor/x") {
		t.Errorf("argv = %q", argv)
	}
}

func TestPathGuardRejectsEscape(t *testing.T) {
	// 경로는 저장소 안의 **상대경로**다. 절대경로나 `..` 를 받으면 저장소 밖을
	// 가리킬 수 있고, git 이 그것을 그대로 따른다.
	for _, bad := range []string{
		"/etc", "../outside", "vendor/../../etc", `C:\win`, "-rf", "--force",
	} {
		m, calls := mgr("", nil)
		if err := m.Update(repoPath, bad, false, false); err == nil {
			t.Errorf("%q: 거부되지 않았다", bad)
		}
		if len(*calls) != 0 {
			t.Errorf("%q: 거부했는데 git 을 실행했다", bad)
		}
	}
}

func TestPathGuardAllowsNormal(t *testing.T) {
	for _, ok := range []string{"vendor/inner", "a", "a/b/c", "my lib"} {
		m, _ := mgr("", nil)
		if err := m.Update(repoPath, ok, false, false); err != nil {
			t.Errorf("%q: 거부됐다: %v", ok, err)
		}
	}
}

/*
TestExecGitKeepsLeadingSpace 는 **실제 Runner** 를 시험한다.

주입 러너로는 볼 수 없는 결함이 하나 있었다: `worktree.execGit` 를 그대로 베껴
출력을 `TrimSpace` 했더니 `ok` 상태 줄의 접두 공백이 사라져 그 줄들이 전부
버려졌다 (실측 — 서브모듈이 하나 있는 저장소가 빈 목록으로 왔다). 파싱은 옳았고
러너가 틀렸으므로, 그 경계를 넘는 시험이 있어야 한다.

`git` 이 없는 환경에서는 건너뛴다 — 이 시험의 부재가 다른 시험을 막지 않는다.
*/
func TestExecGitKeepsLeadingSpace(t *testing.T) {
	dir := t.TempDir()
	// git 없이는 뜻이 없다. `--version` 은 저장소를 요구하지 않는 가장 싼 확인이다.
	if _, err := ExecGit(dir, "--version"); err != nil {
		t.Skip("git 이 없다")
	}
	// 앞뒤에 공백을 둔 문자열을 그대로 되돌려 받는다. `echo` 는 git 의 하위
	// 명령이 아니므로 `-c` 로 별칭을 만든다 — 실제 저장소를 만들지 않고도
	// "출력을 어떻게 다듬는가" 만 잴 수 있다.
	out, err := ExecGit(dir, "-c", "alias.e=!printf ' leading\\n'", "e")
	if err != nil {
		t.Skipf("별칭 실행 불가: %v", err)
	}
	if !strings.HasPrefix(out, " ") {
		t.Fatalf("앞 공백이 지워졌다: %q — submodule status 의 상태 문자가 사라진다", out)
	}
}

func TestRepoGuard(t *testing.T) {
	// repo 는 호출자가 RepoRoot 로 정규화한 절대경로다. 상대경로는 해석 기준이
	// 없어 쓸 수 없다 (RepoRoot 와 같은 근거).
	m, calls := mgr("", nil)
	if _, err := m.List("relative/path"); err == nil {
		t.Error("상대경로 repo 가 거부되지 않았다")
	}
	if len(*calls) != 0 {
		t.Error("거부했는데 git 을 실행했다")
	}
}
