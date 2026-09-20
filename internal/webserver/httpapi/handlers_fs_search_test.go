package httpapi

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// EDITOR_GIT_UX_SRS 묶음 F·G — 이름 찾기와 내용 찾기.
// 검증 V-EQO-1~5, V-EGS-1~5.

// searchFixture 는 홈(= root 에디터의 경로) 아래에 검색 대상을 깐다.
// 제외 디렉터리와 이진 파일을 함께 두어 그것들이 걸러지는지 같은 픽스처로 본다.
func searchFixture(t *testing.T, home string) {
	t.Helper()
	write := func(rel, body string) {
		t.Helper()
		p := filepath.Join(home, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("src/app.go", "package main\nfunc Handler() {}\n")
	write("src/util/helper.go", "package util\n// Handler 를 돕는다\n")
	write("src/app.test.js", "test('Handler', () => {})\n")
	write("README.md", "no match here\n")
	// FR-EQO-5 · FR-EGS-7: 제외 대상. 이름으로도 내용으로도 나오면 안 된다.
	write("node_modules/pkg/app.go", "func Handler() {}\n")
	write(".git/config", "Handler\n")
	// FR-EGS-5: 이진 파일.
	write("bin/blob.dat", "Handler\x00\x01\x02binary\n")
}

func fsFindReq(t *testing.T, s *Server, root, q string) (int, map[string]any) {
	t.Helper()
	return fsReq(t, s, "GET",
		"/api/fs/find?root="+url.QueryEscape(root)+"&q="+url.QueryEscape(q), "")
}

func fsGrepReq(t *testing.T, s *Server, root, q string) (int, map[string]any) {
	t.Helper()
	return fsReq(t, s, "GET",
		"/api/fs/grep?root="+url.QueryEscape(root)+"&q="+url.QueryEscape(q), "")
}

// 응답의 상대경로 집합. 순서는 계약이 아니므로 집합으로 본다.
func pathSet(t *testing.T, body map[string]any, key string) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	items, _ := body[key].([]any)
	for _, it := range items {
		m, ok := it.(map[string]any)
		if !ok {
			t.Fatalf("항목이 객체가 아니다: %#v", it)
		}
		p, _ := m["path"].(string)
		out[p] = true
	}
	return out
}

// V-EQO-1: 부분 문자열·대소문자 무시로 찾는다 (FR-EQO-3).
func TestFSFindMatchesSubstringCaseInsensitive(t *testing.T) {
	s, _, home := fsTestServer(t)
	searchFixture(t, home)

	code, body := fsFindReq(t, s, home, "APP")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, body)
	}
	got := pathSet(t, body, "files")
	for _, want := range []string{"src/app.go", "src/app.test.js"} {
		if !got[want] {
			t.Fatalf("%q 가 결과에 없다: %v", want, got)
		}
	}
	if got["README.md"] {
		t.Fatalf("맞지 않는 파일이 들어왔다: %v", got)
	}
}

// 경로 구분자가 든 질의는 상대경로 전체에 대해 매칭한다 (FR-EQO-3).
func TestFSFindMatchesOnRelativePath(t *testing.T) {
	s, _, home := fsTestServer(t)
	searchFixture(t, home)

	_, body := fsFindReq(t, s, home, "util/help")
	got := pathSet(t, body, "files")
	if !got["src/util/helper.go"] {
		t.Fatalf("경로 질의가 맞지 않았다: %v", got)
	}
}

// V-EQO-4: 제외 디렉터리 아래는 결과에 없다 (FR-EQO-5).
func TestFSFindSkipsExcludedDirs(t *testing.T) {
	s, _, home := fsTestServer(t)
	searchFixture(t, home)

	_, body := fsFindReq(t, s, home, "app.go")
	got := pathSet(t, body, "files")
	if !got["src/app.go"] {
		t.Fatalf("정상 파일이 빠졌다: %v", got)
	}
	for p := range got {
		if strings.HasPrefix(p, "node_modules/") || strings.HasPrefix(p, ".git/") {
			t.Fatalf("제외 대상이 들어왔다: %q — FR-EQO-5 위반", p)
		}
	}
}

// V-EQO-2: 등록되지 않은 루트는 거부된다 (FR-EQO-2).
func TestFSFindRejectsUnknownRoot(t *testing.T) {
	s, _, home := fsTestServer(t)
	searchFixture(t, home)

	code, body := fsFindReq(t, s, filepath.Join(home, "src"), "app")
	if code != http.StatusForbidden || body["code"] != fsErrOutsideRoot {
		t.Fatalf("code=%d body=%v, want 403 %s", code, body, fsErrOutsideRoot)
	}
}

// V-EQO-3: 상한에서 끊고 truncated 를 준다 (FR-EQO-4).
func TestFSFindTruncatesAtLimit(t *testing.T) {
	s, _, home := fsTestServer(t)
	dir := filepath.Join(home, "many")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := range 30 {
		name := filepath.Join(dir, "hit"+string(rune('a'+i%26))+string(rune('a'+i/26))+".txt")
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	code, body := fsReq(t, s, "GET",
		"/api/fs/find?root="+url.QueryEscape(home)+"&q=hit&limit=5", "")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, body)
	}
	files, _ := body["files"].([]any)
	if len(files) != 5 {
		t.Fatalf("결과 %d개, want 5", len(files))
	}
	if body["truncated"] != true {
		t.Fatalf("truncated=%v, want true", body["truncated"])
	}
}

// V-EQO-5: 순환 심링크가 있어도 끝난다 (FR-EQO-6).
func TestFSFindDoesNotFollowSymlinkLoop(t *testing.T) {
	s, _, home := fsTestServer(t)
	searchFixture(t, home)
	loop := filepath.Join(home, "src", "loop")
	if err := os.Symlink(home, loop); err != nil {
		t.Skip("이 호스트에서 심링크를 만들 수 없다")
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		fsFindReq(t, s, home, "app.go")
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("순환 심링크에서 끝나지 않았다 — FR-EQO-6 위반")
	}
}

// V-EGS-1: 경로·줄번호·줄내용·매칭구간이 온다 (FR-EGS-1).
func TestFSGrepReturnsLineMatches(t *testing.T) {
	s, _, home := fsTestServer(t)
	searchFixture(t, home)

	code, body := fsGrepReq(t, s, home, "Handler")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, body)
	}
	items, _ := body["matches"].([]any)
	if len(items) == 0 {
		t.Fatalf("결과가 비었다: %v", body)
	}
	var found bool
	for _, it := range items {
		m := it.(map[string]any)
		if m["path"] != "src/app.go" {
			continue
		}
		found = true
		if ln, _ := m["line"].(float64); ln != 2 {
			t.Fatalf("line=%v, want 2", m["line"])
		}
		if txt, _ := m["text"].(string); !strings.Contains(txt, "Handler") {
			t.Fatalf("text=%q", txt)
		}
		if c, _ := m["col"].(float64); c < 1 {
			t.Fatalf("col=%v, want ≥1", m["col"])
		}
	}
	if !found {
		t.Fatalf("src/app.go 의 결과가 없다: %v", items)
	}
}

// V-EGS-3: 이진 파일과 제외 디렉터리는 결과에 없다 (FR-EGS-5·7).
func TestFSGrepSkipsBinaryAndExcluded(t *testing.T) {
	s, _, home := fsTestServer(t)
	searchFixture(t, home)

	_, body := fsGrepReq(t, s, home, "Handler")
	got := pathSet(t, body, "matches")
	for p := range got {
		if strings.HasPrefix(p, "node_modules/") || strings.HasPrefix(p, ".git/") {
			t.Fatalf("제외 대상이 들어왔다: %q — FR-EGS-7 위반", p)
		}
		if strings.HasPrefix(p, "bin/") {
			t.Fatalf("이진 파일이 들어왔다: %q — FR-EGS-5 위반", p)
		}
	}
}

// V-EGS-2: 어느 구현을 썼는지 응답에 실린다 (FR-EGS-3).
func TestFSGrepReportsEngine(t *testing.T) {
	s, _, home := fsTestServer(t)
	searchFixture(t, home)

	_, body := fsGrepReq(t, s, home, "Handler")
	eng, _ := body["engine"].(string)
	if eng != grepEngineRipgrep && eng != grepEngineGo {
		t.Fatalf("engine=%q, want %q 또는 %q", eng, grepEngineRipgrep, grepEngineGo)
	}
}

// V-EGS-2: 두 구현의 결과 형태가 같다 (FR-EGS-4). ripgrep 이 없는 호스트에서는
// 비교할 대상이 없으므로 건너뛴다.
func TestFSGrepEnginesAgree(t *testing.T) {
	_, _, home := fsTestServer(t)
	searchFixture(t, home)

	rg := lookRipgrep()
	if rg == "" {
		t.Skip("이 호스트에 ripgrep 이 없다")
	}
	ctx := context.Background()
	a, _, err := grepWithRipgrep(ctx, rg, home, "Handler", 100)
	if err != nil {
		t.Fatalf("ripgrep: %v", err)
	}
	b, _, err := grepWithGo(ctx, home, "Handler", 100)
	if err != nil {
		t.Fatalf("go: %v", err)
	}
	norm := func(ms []grepMatch) map[string]bool {
		out := map[string]bool{}
		for _, m := range ms {
			out[m.Path+":"+itoaGrep(m.Line)] = true
		}
		return out
	}
	ga, gb := norm(a), norm(b)
	for k := range ga {
		if !gb[k] {
			t.Fatalf("ripgrep 만 찾은 것: %s — FR-EGS-4 위반", k)
		}
	}
	for k := range gb {
		if !ga[k] {
			t.Fatalf("Go 만 찾은 것: %s — FR-EGS-4 위반", k)
		}
	}
}

// V-EGS-5: 셸 메타문자가 든 질의가 그대로 검색어로 쓰인다 (FR-EGS-9).
// 셸을 거치면 이것이 명령이 된다.
func TestFSGrepTreatsShellMetacharsAsLiteral(t *testing.T) {
	s, _, home := fsTestServer(t)
	if err := os.WriteFile(filepath.Join(home, "meta.txt"),
		[]byte("value=$(id); rm -rf /\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	code, body := fsGrepReq(t, s, home, "$(id)")
	if code != 200 {
		t.Fatalf("code=%d body=%v", code, body)
	}
	got := pathSet(t, body, "matches")
	if !got["meta.txt"] {
		t.Fatalf("리터럴 질의가 맞지 않았다: %v", got)
	}
}

// V-EGS-4: 컨텍스트를 끊으면 곧바로 돌아온다 (FR-EGS-8).
func TestFSGrepStopsOnContextCancel(t *testing.T) {
	_, _, home := fsTestServer(t)
	searchFixture(t, home)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if _, _, err := grepWithGo(ctx, home, "Handler", 100); err == nil {
		t.Fatal("취소된 컨텍스트인데 오류가 없다 — FR-EGS-8 위반")
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("취소에 %v 걸렸다", el)
	}
}

// 빈 질의는 거부한다 — 저장소 전체를 뱉는 요청이 된다.
func TestFSSearchRejectsEmptyQuery(t *testing.T) {
	s, _, home := fsTestServer(t)
	for _, path := range []string{"/api/fs/find", "/api/fs/grep"} {
		code, body := fsReq(t, s, "GET", path+"?root="+url.QueryEscape(home)+"&q=", "")
		if code == 200 {
			t.Fatalf("%s: 빈 질의가 통과했다: %v", path, body)
		}
	}
}

// ── 성능: grep 이 파일을 통째로 올리지 않는다 (PERFORMANCE_HARDENING_SRS 묶음 P-C) ──

// TC-PRF-19: 줄 단위로 바꾸면서 **조각 내는 규칙이 한 글자도 바뀌지 않는다**
// (FR-PRF-58·59).
//
// 이것이 이 항목의 위험이다 — `bufio.Scanner` 의 기본 `ScanLines` 는 `\r\n` 을
// 함께 처리해 CRLF 파일의 `Col` 을 바꾼다. 그래서 `Scanner` 가 아니라
// `ReadString('\n')` 을 쓰고, 그 선택을 여기서 잠근다.
func TestGrepWithGo_LineSplittingUnchanged(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// LF · CRLF · 종결자 없는 마지막 줄 · 이진 · 빈 파일.
	write("lf.txt", "alpha\nNEEDLE here\nomega\n")
	write("crlf.txt", "alpha\r\nxx NEEDLE\r\nomega\r\n")
	write("noeol.txt", "alpha\nNEEDLE last")
	write("bin.dat", "NEEDLE\x00binary\n")
	write("empty.txt", "")

	got, truncated, err := grepWithGo(context.Background(), dir, "NEEDLE", 100)
	if err != nil {
		t.Fatalf("grepWithGo: %v", err)
	}
	if truncated {
		t.Fatal("잘렸다고 답했다")
	}
	want := map[string]grepMatch{
		// `Col` 은 `\r` 을 떼기 **전** 줄에서의 자리다 — CRLF 라고 달라지지 않는다.
		"lf.txt":    {Path: "lf.txt", Line: 2, Col: 1, Text: "NEEDLE here"},
		"crlf.txt":  {Path: "crlf.txt", Line: 2, Col: 4, Text: "xx NEEDLE"},
		"noeol.txt": {Path: "noeol.txt", Line: 2, Col: 1, Text: "NEEDLE last"},
	}
	if len(got) != len(want) {
		t.Fatalf("맞은 줄 %d개, want %d: %+v", len(got), len(want), got)
	}
	for _, m := range got {
		w, ok := want[m.Path]
		if !ok {
			t.Fatalf("이진 파일이나 빈 파일이 걸렸다: %+v", m)
		}
		if m != w {
			t.Fatalf("%s: got %+v, want %+v", m.Path, m, w)
		}
	}
}

// 벽시계가 아니라 **할당**을 기록한다 (FR-PRF-60 · TC-PRF-28).
//
// 종전에는 파일당 ① `os.ReadFile` 로 전체 ② `string(blob)` 로 한 벌 더
// ③ `strings.Split` 로 줄 수만큼의 헤더였다. ripgrep 이 없는 환경의 기본 경로이므로
// 파일 5,000개 트리에서 이것이 GB 단위가 됐다 (`AUDIT-go-http.md` P-4).
func BenchmarkGrepWithGo(b *testing.B) {
	dir := b.TempDir()
	var sb strings.Builder
	for i := 0; i < 4000; i++ {
		sb.WriteString("line ")
		sb.WriteString(strconv.Itoa(i))
		sb.WriteString(" of some source file with a fair amount of text on it\n")
	}
	body := sb.String()
	for i := 0; i < 40; i++ {
		if err := os.WriteFile(filepath.Join(dir, "f"+strconv.Itoa(i)+".txt"), []byte(body), 0o644); err != nil {
			b.Fatal(err)
		}
	}
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, _, err := grepWithGo(ctx, dir, "line 3999 of", 100); err != nil {
			b.Fatal(err)
		}
	}
}
