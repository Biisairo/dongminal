package query

import (
	"context"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 묶음 L 서버측 — refs 조회 (GIT_SRS §3C.1 FR-GIT-122·123, 검증 V45·V50).

// refRec 은 for-each-ref 레코드 하나다. **for-each-ref 에는 -z 가 없다** (git 2.50.1
// 은 `unknown switch 'z'`) — 레코드는 개행으로 끝나고 필드만 NUL 로 나뉜다.
func refRec(refname, oid, upstream, track, head, subject, at string) string {
	return strings.Join([]string{refname, oid, upstream, track, head, subject, at}, "\x00")
}

func refStream(recs ...string) string { return strings.Join(recs, "\n") + "\n" }

type refsFake struct {
	stdout string
	argvs  [][]string
}

func (f *refsFake) run(_ context.Context, _ string, args []string) (core.Output, error) {
	f.argvs = append(f.argvs, append([]string(nil), args...))
	return core.Output{Stdout: f.stdout}, nil
}

// R1 (FR-GIT-122): 3개 네임스페이스가 각각 종류로 갈린다. 짧은 이름은 접두를 뗀
// 것이며, 슬래시가 든 로컬 브랜치를 원격으로 오판하지 않는다.
func TestParseRefs_Kinds(t *testing.T) {
	out := refStream(
		refRec("refs/heads/main", "aa", "origin/main", "[ahead 2, behind 1]", "*", "머지 side", "1700000000"),
		refRec("refs/heads/feature/a b", "bb", "", "", " ", "기능 작업", "1700000001"),
		refRec("refs/remotes/origin/main", "cc", "", "", " ", "머지 side", "1700000002"),
		refRec("refs/tags/v1.0", "dd", "", "", " ", "태그가 가리키는 제목", "1700000003"),
	)
	rs, err := ParseRefs(out)
	if err != nil {
		t.Fatalf("ParseRefs: %v", err)
	}
	if len(rs) != 4 {
		t.Fatalf("ref 수 = %d: %+v", len(rs), rs)
	}
	want := []Ref{
		{Name: "refs/heads/main", Short: "main", Kind: RefKindLocal, Oid: "aa", Upstream: "origin/main",
			Ahead: 2, Behind: 1, IsHead: true, Subject: "머지 side", AtUnixMs: 1700000000000},
		{Name: "refs/heads/feature/a b", Short: "feature/a b", Kind: RefKindLocal, Oid: "bb",
			Subject: "기능 작업", AtUnixMs: 1700000001000},
		{Name: "refs/remotes/origin/main", Short: "origin/main", Kind: RefKindRemote, Oid: "cc",
			Subject: "머지 side", AtUnixMs: 1700000002000},
		{Name: "refs/tags/v1.0", Short: "v1.0", Kind: RefKindTag, Oid: "dd",
			Subject: "태그가 가리키는 제목", AtUnixMs: 1700000003000},
	}
	for i, w := range want {
		if rs[i] != w {
			t.Fatalf("refs[%d] = %+v\nwant      %+v", i, rs[i], w)
		}
	}
}

// R2 (FR-GIT-33 의 정신): %(upstream:track) 은 한쪽만 있을 수 있고 [gone] 도 있다.
// 위치로 세면 `[behind 1]` 이 ahead 로 읽힌다.
func TestParseRefs_Track(t *testing.T) {
	for _, tc := range []struct {
		track  string
		ahead  int
		behind int
		gone   bool
	}{
		{"", 0, 0, false},
		{"[ahead 2]", 2, 0, false},
		{"[behind 3]", 0, 3, false},
		{"[ahead 2, behind 1]", 2, 1, false},
		{"[gone]", 0, 0, true},
	} {
		t.Run(tc.track, func(t *testing.T) {
			rs, err := ParseRefs(refStream(refRec("refs/heads/main", "aa", "origin/main", tc.track, " ", "s", "1")))
			if err != nil {
				t.Fatalf("ParseRefs: %v", err)
			}
			if rs[0].Ahead != tc.ahead || rs[0].Behind != tc.behind || rs[0].Gone != tc.gone {
				t.Fatalf("%+v", rs[0])
			}
		})
	}
}

// R3 (V45): 필드가 모자란 레코드는 오류다. 조용히 건너뛰면 사이드바에서 브랜치가
// 사라지고 사용자는 없는 브랜치를 없다고 믿는다.
func TestParseRefs_ShortRecordIsError(t *testing.T) {
	out := refStream(
		refRec("refs/heads/main", "aa", "", "", "*", "s", "1"),
		strings.Join([]string{"refs/heads/side", "bb", ""}, "\x00"),
	)
	if _, err := ParseRefs(out); err == nil {
		t.Fatal("오류가 아니다")
	}
}

// 시각이 비어도 오류가 아니다 — annotated tag 는 committerdate 가 없고, 그 사실이
// 목록을 못 보일 이유는 아니다.
func TestParseRefs_EmptyDate(t *testing.T) {
	rs, err := ParseRefs(refStream(refRec("refs/tags/v2.0", "dd", "", "", " ", "annotated", "")))
	if err != nil {
		t.Fatalf("ParseRefs: %v", err)
	}
	if rs[0].AtUnixMs != 0 || rs[0].Kind != RefKindTag {
		t.Fatalf("%+v", rs[0])
	}
}

func TestParseRefs_Empty(t *testing.T) {
	rs, err := ParseRefs("")
	if err != nil {
		t.Fatalf("ParseRefs: %v", err)
	}
	if rs == nil || len(rs) != 0 {
		t.Fatalf("rs = %#v", rs)
	}
}

// R4: 세 네임스페이스만 묻는다 — 패턴을 주지 않으면 refs/stash·refs/notes 가 함께
// 와서 종류 없는 항목이 사이드바에 섞인다.
func TestRefs_Argv(t *testing.T) {
	f := &refsFake{stdout: ""}
	if _, err := Refs(core.New(core.WithRunner(f.run)), context.Background(), absRepo); err != nil {
		t.Fatalf("Refs: %v", err)
	}
	want := "for-each-ref " + refsFormat + " refs/heads refs/remotes refs/tags"
	if got := strings.Join(f.argvs[0], " "); got != want {
		t.Fatalf("argv = %q\nwant   %q", got, want)
	}
}

// R5 (V45): 실제 git 으로 필드 배치를 고정한다. upstream·ahead 는 원격이 있어야
// 나오므로 bare 원격을 붙인 저장소를 쓴다.
func TestRefs_RealGit(t *testing.T) {
	repo := logRealRepo(t)
	remote := t.TempDir()
	gitIn(t, remote, "init", "-q", "--bare", remote)
	gitIn(t, repo, "remote", "add", "origin", remote)
	gitIn(t, repo, "push", "-q", "-u", "origin", "main")
	gitIn(t, repo, "commit", "-q", "--allow-empty", "-m", "ahead 1")

	rs, err := Refs(core.New(), context.Background(), repo)
	if err != nil {
		t.Fatalf("Refs: %v", err)
	}
	byName := map[string]Ref{}
	for _, r := range rs {
		byName[r.Name] = r
	}
	main, ok := byName["refs/heads/main"]
	if !ok {
		t.Fatalf("main 이 없다: %+v", rs)
	}
	if main.Short != "main" || main.Kind != RefKindLocal || !main.IsHead {
		t.Fatalf("main = %+v", main)
	}
	if len(main.Oid) != 40 || main.AtUnixMs == 0 {
		t.Fatalf("main = %+v", main)
	}
	if main.Upstream != "origin/main" || main.Ahead != 1 || main.Behind != 0 {
		t.Fatalf("upstream = %+v", main)
	}
	side, ok := byName["refs/heads/side"]
	if !ok || side.IsHead || side.Upstream != "" {
		t.Fatalf("side = %+v", side)
	}
	if r, ok := byName["refs/remotes/origin/main"]; !ok || r.Kind != RefKindRemote || r.Short != "origin/main" {
		t.Fatalf("원격 = %+v", byName)
	}
	tag, ok := byName["refs/tags/v1.0"]
	if !ok || tag.Kind != RefKindTag || tag.Short != "v1.0" || tag.AtUnixMs == 0 {
		t.Fatalf("태그 = %+v", byName)
	}
}

// annotated tag 도 시각을 갖는다 — committerdate 는 태그 객체에서 비므로 creatordate
// 를 쓴다 (git 2.50.1 실측). 0 을 주면 사이드바가 1970년을 보인다.
func TestRefs_RealGit_AnnotatedTag(t *testing.T) {
	repo := logRealRepo(t)
	gitIn(t, repo, "tag", "-a", "v2.0", "-m", "annotated 태그 메시지")

	rs, err := Refs(core.New(), context.Background(), repo)
	if err != nil {
		t.Fatalf("Refs: %v", err)
	}
	for _, r := range rs {
		if r.Name == "refs/tags/v2.0" {
			if r.Kind != RefKindTag || r.AtUnixMs == 0 {
				t.Fatalf("annotated 태그 = %+v", r)
			}
			return
		}
	}
	t.Fatalf("v2.0 이 없다: %+v", rs)
}

// V-DSP-2 (UX_BATCH6_SRS FR-DSP-3): 태그는 **최신이 위**다.
//
// for-each-ref 의 기본은 refname 오름차순이라 맨 위가 가장 오래된 태그였고,
// 판 이름은 사전순이 뜻을 갖지 않는다 — `v1.10` 이 `v1.9` 보다 위에 왔다.
func TestParseRefs_TagsNewestFirst(t *testing.T) {
	out := refStream(
		refRec("refs/tags/v1.10", "aa", "", "", " ", "십", "1700000010"),
		refRec("refs/tags/v1.2", "bb", "", "", " ", "이", "1700000002"),
		refRec("refs/tags/v1.9", "cc", "", "", " ", "구", "1700000009"),
	)
	rs, err := ParseRefs(out)
	if err != nil {
		t.Fatalf("ParseRefs: %v", err)
	}
	var got []string
	for _, r := range rs {
		got = append(got, r.Short)
	}
	want := []string{"v1.10", "v1.9", "v1.2"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("태그 순서 = %v, want %v", got, want)
		}
	}
}

// FR-DSP-4: 브랜치의 순서는 바뀌지 않는다. 그리고 종류 사이의 배치도 그대로다 —
// 태그가 있던 자리에 태그가 돌아온다.
func TestParseRefs_BranchOrderUntouched(t *testing.T) {
	out := refStream(
		refRec("refs/heads/main", "aa", "", "", "*", "메인", "1700000001"),
		refRec("refs/tags/v1.0", "bb", "", "", " ", "일", "1700000002"),
		refRec("refs/heads/zzz", "cc", "", "", " ", "제트", "1700000003"),
		refRec("refs/tags/v2.0", "dd", "", "", " ", "이", "1700000009"),
	)
	rs, err := ParseRefs(out)
	if err != nil {
		t.Fatalf("ParseRefs: %v", err)
	}
	want := []string{"main", "v2.0", "zzz", "v1.0"}
	for i, w := range want {
		if rs[i].Short != w {
			t.Fatalf("순서 = %s want %s (전체 %+v)", rs[i].Short, w, rs)
		}
	}
}

// 시각이 같으면 이름으로 가른다 — 한 커밋에 여러 태그를 단 저장소에서 순서가
// 호출마다 달라지면 목록이 이유 없이 흔들린다.
func TestParseRefs_TagTieBreaksByName(t *testing.T) {
	out := refStream(
		refRec("refs/tags/a", "aa", "", "", " ", "", "1700000000"),
		refRec("refs/tags/b", "bb", "", "", " ", "", "1700000000"),
	)
	rs, _ := ParseRefs(out)
	if rs[0].Short != "b" || rs[1].Short != "a" {
		t.Fatalf("동시각 태그의 순서가 결정적이지 않다: %s, %s", rs[0].Short, rs[1].Short)
	}
}
