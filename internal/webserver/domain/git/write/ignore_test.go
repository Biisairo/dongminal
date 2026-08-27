package write

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 묶음 F — `.gitignore` 추가 (GIT_ACTIONS_SRS §3.6 FR-GIT-273, 검증 V200).
//
// **git 실행이 아니라 파일 쓰기다.** 그러므로 ExecWrite 를 지나지 않으며, 대신
// 저장소 루트 안의 `.gitignore` 하나만 대상으로 하고 경로를 그 안으로 가둔다.

// T1 (V200): 경로 이탈은 **거부한다.** 클라이언트만 막으면 API 직접 호출이
// 우회하고, 저장소 밖의 파일이 대상이 된다.
func TestIgnorePattern_RejectsEscape(t *testing.T) {
	root := "/repo"
	cases := []struct{ name, path string }{
		{"부모 참조", "../outside.txt"},
		{"중간의 부모 참조", "src/../../outside.txt"},
		{"루트 밖 절대경로", "/etc/passwd"},
		{"루트의 형제", "/repo-other/f.txt"},
		{"빈 경로", ""},
		{"공백뿐", "   "},
		{"NUL", "a\x00b"},
		{"정규화되지 않음", "src//a.txt"},
		{"저장소 루트 자신", "."},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := IgnorePattern(root, c.path)
			if !errors.Is(err, ErrIgnorePath) {
				t.Fatalf("IgnorePattern(%q) = %q, %v — want ErrIgnorePath", c.path, got, err)
			}
		})
	}
}

// T2 (FR-GIT-273): 루트 안의 경로는 **루트에 고정된 한 줄**이 된다. 절대경로로
// 와도 루트 안이면 상대경로로 옮긴다 — 클라이언트가 `repo + '/' + path` 를 보낸다.
func TestIgnorePattern_Accepts(t *testing.T) {
	root := "/repo"
	cases := []struct{ in, want string }{
		{"a.txt", "/a.txt"},
		{"src/a.txt", "/src/a.txt"},
		{"디렉터리 한글/파일 이름.txt", "/디렉터리 한글/파일 이름.txt"},
		{"/repo/a.txt", "/a.txt"},
		{"/repo/src/deep/a.txt", "/src/deep/a.txt"},
	}
	for _, c := range cases {
		got, err := IgnorePattern(root, c.in)
		if err != nil {
			t.Fatalf("IgnorePattern(%q): %v", c.in, err)
		}
		if got != c.want {
			t.Fatalf("IgnorePattern(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// T3 (FR-GIT-273): `.gitignore` 는 **저장소 루트의 것 하나뿐이다.** 하위
// 디렉터리의 `.gitignore` 를 대상으로 삼지 않는다.
func TestIgnoreFile_RootOnly(t *testing.T) {
	dir := t.TempDir()
	if got, want := IgnoreFile(dir), filepath.Join(dir, ".gitignore"); got != want {
		t.Fatalf("IgnoreFile = %q, want %q", got, want)
	}
}

// T4 (V200): 이미 있는 줄은 **더하지 않는다.** 두 번 넣어도 파일은 한 줄만
// 늘어난다.
func TestIgnoreAdd_NoDuplicateLine(t *testing.T) {
	dir := t.TempDir()

	first, err := IgnoreAdd(dir, []string{"a.txt", "src/b.txt"})
	if err != nil {
		t.Fatalf("IgnoreAdd: %v", err)
	}
	if strings.Join(first.Added, ",") != "/a.txt,/src/b.txt" {
		t.Fatalf("added = %v", first.Added)
	}
	if len(first.Skipped) != 0 {
		t.Fatalf("skipped = %v, want []", first.Skipped)
	}

	second, err := IgnoreAdd(dir, []string{"a.txt", "c.txt"})
	if err != nil {
		t.Fatalf("IgnoreAdd(2): %v", err)
	}
	if strings.Join(second.Added, ",") != "/c.txt" {
		t.Fatalf("added(2) = %v, want [/c.txt]", second.Added)
	}
	if strings.Join(second.Skipped, ",") != "/a.txt" {
		t.Fatalf("skipped(2) = %v, want [/a.txt]", second.Skipped)
	}

	body := ignoreRead(t, IgnoreFile(dir))
	if n := strings.Count(body, "/a.txt\n"); n != 1 {
		t.Fatalf("/a.txt 가 %d줄이다 (want 1):\n%s", n, body)
	}
	if body != "/a.txt\n/src/b.txt\n/c.txt\n" {
		t.Fatalf("본문 =\n%q", body)
	}
}

// T5 (V200): 같은 요청 안의 중복도 한 줄이다 — 목록을 한 번 훑고 끝내지 않으면
// 두 줄이 들어간다.
func TestIgnoreAdd_DuplicateWithinRequest(t *testing.T) {
	dir := t.TempDir()
	res, err := IgnoreAdd(dir, []string{"a.txt", "a.txt", filepath.Join(dir, "a.txt")})
	if err != nil {
		t.Fatalf("IgnoreAdd: %v", err)
	}
	if strings.Join(res.Added, ",") != "/a.txt" {
		t.Fatalf("added = %v, want [/a.txt]", res.Added)
	}
	if ignoreRead(t, IgnoreFile(dir)) != "/a.txt\n" {
		t.Fatalf("본문 = %q", ignoreRead(t, IgnoreFile(dir)))
	}
}

// T6 (FR-GIT-273): 파일 끝의 개행을 **보정한다.** 마지막 줄에 개행이 없으면
// 새 줄이 그 줄에 붙어 두 패턴이 하나가 된다.
func TestIgnoreAdd_FixesMissingTrailingNewline(t *testing.T) {
	dir := t.TempDir()
	ignoreWrite(t, IgnoreFile(dir), "node_modules")

	if _, err := IgnoreAdd(dir, []string{"a.txt"}); err != nil {
		t.Fatalf("IgnoreAdd: %v", err)
	}
	if got, want := ignoreRead(t, IgnoreFile(dir)), "node_modules\n/a.txt\n"; got != want {
		t.Fatalf("본문 = %q, want %q", got, want)
	}
}

// T7 (V200): 고정되지 않은 기존 줄(`a.txt`)도 같은 경로를 뜻하므로 다시 넣지
// 않는다. 주석과 빈 줄은 패턴이 아니다.
func TestIgnoreAdd_MatchesUnanchoredExisting(t *testing.T) {
	dir := t.TempDir()
	ignoreWrite(t, IgnoreFile(dir), "# 주석\n\na.txt\n")

	res, err := IgnoreAdd(dir, []string{"a.txt"})
	if err != nil {
		t.Fatalf("IgnoreAdd: %v", err)
	}
	if len(res.Added) != 0 || strings.Join(res.Skipped, ",") != "/a.txt" {
		t.Fatalf("res = %+v", res)
	}
	if got, want := ignoreRead(t, IgnoreFile(dir)), "# 주석\n\na.txt\n"; got != want {
		t.Fatalf("본문 = %q, want %q", got, want)
	}
}

// T8 (V200): 하나라도 이탈이면 **아무것도 쓰지 않는다.** 일부만 쓰고 실패하면
// 사용자는 무엇이 들어갔는지 알 수 없다.
func TestIgnoreAdd_RejectsBeforeWriting(t *testing.T) {
	dir := t.TempDir()
	if _, err := IgnoreAdd(dir, []string{"a.txt", "../outside.txt"}); !errors.Is(err, ErrIgnorePath) {
		t.Fatalf("err = %v, want ErrIgnorePath", err)
	}
	if _, err := os.Stat(IgnoreFile(dir)); !os.IsNotExist(err) {
		t.Fatalf(".gitignore 가 만들어졌다: %v", err)
	}
}

// T9: 빈 목록은 오류다 — 아무 대상 없이 파일을 건드리지 않는다.
func TestIgnoreAdd_EmptyList(t *testing.T) {
	dir := t.TempDir()
	if _, err := IgnoreAdd(dir, nil); !errors.Is(err, ErrIgnorePath) {
		t.Fatalf("err = %v, want ErrIgnorePath", err)
	}
}

func ignoreRead(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("ReadFile(%s): %v", p, err)
	}
	return string(b)
}

func ignoreWrite(t *testing.T, p, body string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatalf("WriteFile(%s): %v", p, err)
	}
}
