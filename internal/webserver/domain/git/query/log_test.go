package query

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 묶음 L 서버측 — 로그 조회 (GIT_SRS §3C.1 FR-GIT-113·114·123·126·128·130, 검증 V45).
//
// 파싱은 실제 git 없이 결정론적으로 돈다. argv 는 Runner 주입(FR-GIT-4)으로 관찰해
// **무엇을 실행하지 않았는가**까지 고정한다.

// logRec 은 레코드 하나를 -z 스트림 조각으로 만든다. 필드 배치를 테스트가 다시
// 적어야 파서와 포맷이 어긋나는 순간 여기서 깨진다.
func logRec(oid, abbrev, parents, an, ae, at, ct, dec, subject string) string {
	return strings.Join([]string{oid, abbrev, parents, an, ae, at, ct, dec, subject}, "\x00")
}

// logStream 은 레코드들을 -z 규약대로 잇는다 — **레코드 사이에만 NUL 이 있고
// 마지막에는 없다** (git 2.50.1 실측).
func logStream(recs ...string) string { return strings.Join(recs, "\x00") }

// logFake 은 stdout 을 그대로 답하며 argv 를 기록한다.
type logFake struct {
	stdout    string
	stderr    string
	exit      int
	truncated bool
	argvs     [][]string
}

func (f *logFake) run(_ context.Context, _ string, args []string) (core.Output, error) {
	f.argvs = append(f.argvs, append([]string(nil), args...))
	return core.Output{Stdout: f.stdout, Stderr: f.stderr, ExitCode: f.exit, StdoutTruncated: f.truncated}, nil
}

func (f *logFake) lastCall() string {
	if len(f.argvs) == 0 {
		return ""
	}
	return strings.Join(f.argvs[len(f.argvs)-1], " ")
}

// L1 (V45, FR-GIT-113): 공백·유니코드가 든 제목과 이름이 그대로 온다. 부모 목록이
// 그래프의 유일한 입력이므로 개수와 순서까지 본다 (FR-GIT-117).
func TestParseLog_Fields(t *testing.T) {
	out := logStream(
		logRec("a1", "a1s", "p1 p2", "김 동민", "dy@example.com", "1700000000", "1700000060",
			"HEAD -> refs/heads/main, tag: refs/tags/v1.0", "머지 · 유니코드  제목"),
		logRec("b2", "b2s", "p1", "tester", "t@example.com", "1700000001", "1700000001", "", "두 번째"),
		logRec("c3", "c3s", "", "tester", "t@example.com", "1700000002", "1700000002", "", "root"),
	)
	cs, err := ParseLog(out)
	if err != nil {
		t.Fatalf("ParseLog: %v", err)
	}
	if len(cs) != 3 {
		t.Fatalf("커밋 수 = %d, want 3", len(cs))
	}
	if cs[0].Oid != "a1" || cs[0].Abbrev != "a1s" || cs[0].Subject != "머지 · 유니코드  제목" {
		t.Fatalf("[0] = %+v", cs[0])
	}
	if cs[0].AuthorName != "김 동민" || cs[0].AuthorMail != "dy@example.com" {
		t.Fatalf("author = %q / %q", cs[0].AuthorName, cs[0].AuthorMail)
	}
	// unix 초를 ms 로 옮긴다. 초 단위를 그대로 실으면 표시 계층이 1000배 틀린다.
	if cs[0].AuthorAt != 1700000000000 || cs[0].CommitAt != 1700000060000 {
		t.Fatalf("시각 = %d / %d", cs[0].AuthorAt, cs[0].CommitAt)
	}
	if len(cs[0].Parents) != 2 || cs[0].Parents[0] != "p1" || cs[0].Parents[1] != "p2" {
		t.Fatalf("parents = %v", cs[0].Parents)
	}
	if len(cs[1].Parents) != 1 {
		t.Fatalf("parents[1] = %v", cs[1].Parents)
	}
	// 루트 커밋의 부모는 **빈 슬라이스**다 — nil 은 JSON 에서 null 이 되고 그래프
	// 입력이 되지 못한다.
	if cs[2].Parents == nil || len(cs[2].Parents) != 0 {
		t.Fatalf("루트 parents = %#v", cs[2].Parents)
	}
}

// L2 (FR-GIT-126): %D 를 배지로 쪼갠다. HEAD 표식은 따로 담고, 종류(local/remote/tag)
// 를 문자열 접두로 남기지 않는다 — 표시 계층이 다시 파싱하면 파싱이 두 곳에 생긴다.
func TestParseLog_Decorations(t *testing.T) {
	for _, tc := range []struct {
		name   string
		dec    string
		isHead bool
		want   []CommitRef
	}{
		{"없음", "", false, []CommitRef{}},
		{"HEAD+브랜치+태그", "HEAD -> refs/heads/main, tag: refs/tags/v2.0, refs/remotes/origin/main", true, []CommitRef{
			{Name: "main", Kind: RefKindLocal, IsHead: true},
			{Name: "v2.0", Kind: RefKindTag},
			{Name: "origin/main", Kind: RefKindRemote},
		}},
		{"detached", "HEAD", true, []CommitRef{}},
		{"detached+브랜치", "HEAD, refs/heads/side", true, []CommitRef{{Name: "side", Kind: RefKindLocal}}},
		{"슬래시_브랜치", "refs/heads/feature/a-b", false, []CommitRef{{Name: "feature/a-b", Kind: RefKindLocal}}},
		{"모르는_네임스페이스", "refs/stash", false, []CommitRef{{Name: "refs/stash"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cs, err := ParseLog(logRec("a", "a", "", "n", "m", "1", "1", tc.dec, "s"))
			if err != nil {
				t.Fatalf("ParseLog: %v", err)
			}
			if cs[0].IsHead != tc.isHead {
				t.Fatalf("IsHead = %v, want %v", cs[0].IsHead, tc.isHead)
			}
			if len(cs[0].Refs) != len(tc.want) {
				t.Fatalf("refs = %+v, want %+v", cs[0].Refs, tc.want)
			}
			for i, w := range tc.want {
				if cs[0].Refs[i] != w {
					t.Fatalf("refs[%d] = %+v, want %+v", i, cs[0].Refs[i], w)
				}
			}
		})
	}
}

// L3 (V45): 필드가 모자란 레코드는 **오류다.** 조용히 건너뛰면 목록이 조용히 틀리고
// 그래프는 없는 부모를 그린다.
func TestParseLog_ShortRecordIsError(t *testing.T) {
	full := logRec("a", "a", "", "n", "m", "1", "1", "", "s")
	for _, tc := range []struct {
		name string
		out  string
	}{
		{"한_레코드가_짧다", strings.Join([]string{"a", "a", "", "n"}, "\x00")},
		{"뒤_레코드가_짧다", full + "\x00" + strings.Join([]string{"b", "b", "", "n", "m"}, "\x00")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := ParseLog(tc.out); err == nil {
				t.Fatal("오류가 아니다")
			}
		})
	}
}

// 빈 stdout 은 커밋 0개다 (빈 저장소에 --all 을 주면 실제로 그렇다 — git 2.50.1
// 실측). nil 이 아니라 빈 슬라이스여야 JSON 이 [] 가 된다.
func TestParseLog_EmptyIsNoCommits(t *testing.T) {
	cs, err := ParseLog("")
	if err != nil {
		t.Fatalf("ParseLog: %v", err)
	}
	if cs == nil || len(cs) != 0 {
		t.Fatalf("cs = %#v", cs)
	}
}

// 마지막 레코드의 제목이 비면 스트림이 NUL 로 끝난다. 꼬리 빈 토큰을 떼는 파서는
// 이 레코드의 필드를 하나 잃고 "짧은 레코드" 로 오판한다.
func TestParseLog_TrailingEmptySubject(t *testing.T) {
	out := logStream(
		logRec("a", "a", "", "n", "m", "1", "1", "", "first"),
		logRec("b", "b", "a", "n", "m", "2", "2", "", ""),
	)
	cs, err := ParseLog(out)
	if err != nil {
		t.Fatalf("ParseLog: %v", err)
	}
	if len(cs) != 2 || cs[1].Oid != "b" || cs[1].Subject != "" {
		t.Fatalf("cs = %+v", cs)
	}
}

// L4 (FR-GIT-114·123·128·130): argv 표. 정렬·페이징·필터가 git 옵션으로 내려가고
// ref 가 비면 --all 이다.
func TestLog_Argv(t *testing.T) {
	base := "log -z " + logFormat + " " + logDecorate
	for _, tc := range []struct {
		name string
		q    LogQuery
		want string
	}{
		{"기본", LogQuery{}, base + " -n 300 --all"},
		{"ref", LogQuery{Ref: "refs/heads/main"}, base + " -n 300 refs/heads/main"},
		{"author-date", LogQuery{Order: LogOrderAuthorDate}, base + " --author-date-order -n 300 --all"},
		{"topo", LogQuery{Order: LogOrderTopo}, base + " --topo-order -n 300 --all"},
		{"date는_기본", LogQuery{Order: LogOrderDate}, base + " -n 300 --all"},
		{"페이징", LogQuery{Skip: 300, Limit: 100}, base + " --skip=300 -n 100 --all"},
		{"필터", LogQuery{Author: "김", Since: "2024-01-01", Until: "2024-02-01", Grep: "fix me"},
			base + " -n 300 --author=김 --since=2024-01-01 --until=2024-02-01 --grep=fix me --all"},
		{"경로는_구분자_뒤", LogQuery{Path: "d ir/한글.txt"}, base + " -n 300 --all -- d ir/한글.txt"},
		{"reflog", LogQuery{Reflog: true}, base + " -n 300 --reflog --all"},
		{"reflog_ref와_함께", LogQuery{Reflog: true, Ref: "refs/heads/main"}, base + " -n 300 --reflog refs/heads/main"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &logFake{}
			q := tc.q
			q.Repo = "/repo"
			if _, err := Log(core.New(core.WithRunner(f.run)), context.Background(), q); err != nil {
				t.Fatalf("Log: %v", err)
			}
			if got := f.lastCall(); got != tc.want {
				t.Fatalf("argv = %q\nwant   %q", got, tc.want)
			}
		})
	}
}

// L5 (FR-GIT-128): 모르는 정렬값은 **거부한다.** 조용히 기본값으로 낮추면 사용자는
// 자기가 고른 순서로 보고 있다고 믿는다.
func TestLog_RejectsUnknownOrder(t *testing.T) {
	f := &logFake{}
	_, err := Log(core.New(core.WithRunner(f.run)), context.Background(), LogQuery{Repo: "/repo", Order: "reverse"})
	if !errors.Is(err, ErrLogOrder) {
		t.Fatalf("err = %v, want ErrLogOrder", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부했는데 실행했다: %v", f.argvs)
	}
}

// ref 는 위치 인자로 들어가므로 옵션처럼 생긴 값은 받지 않는다 (FR-GIT-62).
func TestLog_RejectsOptionLikeRef(t *testing.T) {
	f := &logFake{}
	_, err := Log(core.New(core.WithRunner(f.run)), context.Background(), LogQuery{Repo: "/repo", Ref: "--all"})
	if !errors.Is(err, ErrUnsafeRev) {
		t.Fatalf("err = %v, want ErrUnsafeRev", err)
	}
	if len(f.argvs) != 0 {
		t.Fatalf("거부했는데 실행했다: %v", f.argvs)
	}
}

// L6 (FR-GIT-114): limit 은 상한으로 접고, 0 이하는 초기 기본값이다.
func TestLogLimit_Clamps(t *testing.T) {
	for _, tc := range []struct {
		in, want int
	}{
		{0, LogInitialLimit}, {-5, LogInitialLimit}, {1, 1}, {LogPageLimit, LogPageLimit},
		{LogMaxLimit, LogMaxLimit}, {LogMaxLimit + 1, LogMaxLimit}, {1 << 20, LogMaxLimit},
	} {
		if got := LogLimit(tc.in); got != tc.want {
			t.Fatalf("LogLimit(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

// 잘린 stdout 을 목록으로 주면 조용히 짧은 목록이 된다 — 상한 초과를 diff 와 같이
// 오류로 다룬다.
func TestLog_TruncatedOutputIsError(t *testing.T) {
	f := &logFake{stdout: logRec("a", "a", "", "n", "m", "1", "1", "", "s"), truncated: true}
	if _, err := Log(core.New(core.WithRunner(f.run)), context.Background(), LogQuery{Repo: "/repo"}); err == nil {
		t.Fatal("오류가 아니다")
	}
}

// 없는 ref 는 404 로 갈라져야 한다 — 저장소 실패(500)와 구분되지 않으면 클라이언트가
// 자기 요청이 틀렸다는 것을 알 수 없다.
func TestLog_UnknownRevIsNotFound(t *testing.T) {
	f := &logFake{exit: 128, stderr: "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree.\n"}
	_, err := Log(core.New(core.WithRunner(f.run)), context.Background(), LogQuery{Repo: "/repo", Ref: "nope"})
	if !errors.Is(err, ErrRevNotFound) {
		t.Fatalf("err = %v, want ErrRevNotFound", err)
	}
}

// logRealRepo 는 파싱을 실제 git 에 걸어 고정하기 위한 작은 DAG 다.
//
//	c3(root) ← c2 ← ren ←┐
//	              ↖ side ←┴ merge (HEAD, tag v1.0)
//
// 픽스처 스크립트의 many-commits 를 쓰지 않는 이유는 python3 의존과 10,000 커밋
// 생성을 단위 테스트마다 지불하지 않기 위해서다 — 형태는 여기서 더 촘촘히 고정한다.
func logRealRepo(t *testing.T) string {
	t.Helper()
	repo := tempRepo(t) // README.md 1개 + "init" 커밋
	write := func(rel, body string) {
		t.Helper()
		p := filepath.Join(repo, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("b.txt", "b\n")
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-m", "두 번째 · 유니코드\n\n본문 첫 줄\n본문 둘째 줄\n")

	gitIn(t, repo, "checkout", "-q", "-b", "side")
	write("d ir/한글 파일.txt", "s\n")
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-m", "side 쪽 변경")

	gitIn(t, repo, "checkout", "-q", "main")
	gitIn(t, repo, "mv", "README.md", "RE ADME.md")
	gitIn(t, repo, "commit", "-m", "rename with space")

	gitIn(t, repo, "merge", "-q", "--no-ff", "side", "-m", "merge side")
	gitIn(t, repo, "tag", "v1.0")
	return repo
}

// L7 (V45, FR-GIT-113·126): 실제 git 으로 필드 배치와 배지를 고정한다. 단위 픽스처는
// 내가 믿는 형식일 뿐이므로, git 이 형식을 바꾸면 여기서 먼저 깨져야 한다.
func TestLog_RealGit(t *testing.T) {
	repo := logRealRepo(t)
	cs, err := Log(core.New(), context.Background(), LogQuery{Repo: repo, Order: LogOrderTopo})
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if len(cs) != 5 {
		t.Fatalf("커밋 수 = %d, want 5: %+v", len(cs), cs)
	}
	head := cs[0]
	if head.Subject != "merge side" || len(head.Parents) != 2 {
		t.Fatalf("HEAD = %+v", head)
	}
	if len(head.Oid) != 40 || head.Abbrev == "" || len(head.Abbrev) >= len(head.Oid) {
		t.Fatalf("oid/abbrev = %q / %q", head.Oid, head.Abbrev)
	}
	if !head.IsHead {
		t.Fatalf("HEAD 표식이 없다: %+v", head)
	}
	kinds := map[string]string{}
	for _, r := range head.Refs {
		kinds[r.Name] = r.Kind
	}
	if kinds["main"] != RefKindLocal || kinds["v1.0"] != RefKindTag {
		t.Fatalf("배지 = %+v", head.Refs)
	}
	// 루트 커밋은 목록의 끝이며 부모가 없다.
	root := cs[len(cs)-1]
	if root.Subject != "init" || len(root.Parents) != 0 {
		t.Fatalf("root = %+v", root)
	}
	// 제목이 본문에 삼켜지지 않는다 — %s 는 첫 줄뿐이다.
	var second Commit
	for _, c := range cs {
		if strings.HasPrefix(c.Subject, "두 번째") {
			second = c
		}
	}
	if second.Subject != "두 번째 · 유니코드" {
		t.Fatalf("subject = %q", second.Subject)
	}
}

// 페이징이 실제로 창을 옮긴다 (FR-GIT-114). skip 이 무시되면 추가 로드가 같은
// 페이지를 되풀이하고 목록이 늘지 않는다.
func TestLog_RealGit_Paging(t *testing.T) {
	repo := logRealRepo(t)
	s := core.New()
	ctx := context.Background()
	all, err := Log(s, ctx, LogQuery{Repo: repo, Order: LogOrderTopo})
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	page, err := Log(s, ctx, LogQuery{Repo: repo, Order: LogOrderTopo, Skip: 2, Limit: 2})
	if err != nil {
		t.Fatalf("Log(skip): %v", err)
	}
	if len(page) != 2 || page[0].Oid != all[2].Oid || page[1].Oid != all[3].Oid {
		t.Fatalf("페이지 = %+v", page)
	}
}

// ref 필터와 경로 필터가 실제로 목록을 좁힌다 (FR-GIT-123·130).
func TestLog_RealGit_Filters(t *testing.T) {
	repo := logRealRepo(t)
	s := core.New()
	ctx := context.Background()
	// side 브랜치에는 merge 도 rename 도 없다.
	onSide, err := Log(s, ctx, LogQuery{Repo: repo, Ref: "refs/heads/side"})
	if err != nil {
		t.Fatalf("Log(ref): %v", err)
	}
	for _, c := range onSide {
		if c.Subject == "merge side" || c.Subject == "rename with space" {
			t.Fatalf("side 에 main 커밋이 들었다: %+v", onSide)
		}
	}
	byPath, err := Log(s, ctx, LogQuery{Repo: repo, Path: "d ir/한글 파일.txt"})
	if err != nil {
		t.Fatalf("Log(path): %v", err)
	}
	if len(byPath) != 1 || byPath[0].Subject != "side 쪽 변경" {
		t.Fatalf("경로 필터 = %+v", byPath)
	}
	byAuthor, err := Log(s, ctx, LogQuery{Repo: repo, Author: "nobody-such-author"})
	if err != nil {
		t.Fatalf("Log(author): %v", err)
	}
	if len(byAuthor) != 0 {
		t.Fatalf("author 필터 = %+v", byAuthor)
	}
}

// 커밋이 없는 저장소는 오류가 아니라 빈 목록이다 — 첫 커밋 전의 History 탭이
// 실패 문구를 보이면 사용자는 저장소가 깨졌다고 읽는다.
func TestLog_RealGit_EmptyRepo(t *testing.T) {
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	gitIn(t, dir, "init", "-b", "main", dir)
	cs, err := Log(core.New(), context.Background(), LogQuery{Repo: dir})
	if err != nil {
		t.Fatalf("Log: %v", err)
	}
	if len(cs) != 0 {
		t.Fatalf("cs = %+v", cs)
	}
}

// L11 (FR-GIT-280): reflog 토글이 **어떤 ref 도 가리키지 않게 된 커밋**을 목록에
// 들인다. 껐을 때 그 커밋이 보이면 토글이 무의미하므로 양쪽을 다 본다 — 켠 쪽만
// 보면 "원래 보이던 것"과 구분되지 않는다.
func TestLog_RealGit_Reflog(t *testing.T) {
	repo := tempRepo(t)
	writeFile(t, repo, "dropped.txt", "x\n")
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-m", "버려질 커밋")
	// reset 은 ref 를 되돌릴 뿐 커밋을 지우지 않는다 — 그 커밋은 이제 reflog 로만
	// 닿는다. Git Graph 의 reflog 토글이 겨냥하는 상태가 정확히 이것이다.
	gitIn(t, repo, "reset", "--hard", "HEAD~1")

	s := core.New()
	ctx := context.Background()
	has := func(cs []Commit, subject string) bool {
		for _, c := range cs {
			if c.Subject == subject {
				return true
			}
		}
		return false
	}

	off, err := Log(s, ctx, LogQuery{Repo: repo, Order: LogOrderTopo})
	if err != nil {
		t.Fatalf("Log(off): %v", err)
	}
	if has(off, "버려질 커밋") {
		t.Fatalf("토글이 꺼졌는데 reflog 커밋이 보인다: %+v", off)
	}

	on, err := Log(s, ctx, LogQuery{Repo: repo, Order: LogOrderTopo, Reflog: true})
	if err != nil {
		t.Fatalf("Log(on): %v", err)
	}
	if !has(on, "버려질 커밋") {
		t.Fatalf("reflog 커밋이 목록에 없다: %+v", on)
	}
}
