package query

import (
	"context"
	"errors"
	"strings"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// 묶음 B·C 서버측 — porcelain v2 파싱 (GIT_SRS §3.5 FR-GIT-32~37, 검증 V9).
//
// 레코드는 NUL 로 끝난다 — 헤더(`# ...`)도 마찬가지다. 그래서 픽스처는 개행이
// 아니라 NUL 로 이어붙인다.

func nulRecords(recs ...string) string {
	return strings.Join(recs, "\x00") + "\x00"
}

const (
	hdrOid  = "# branch.oid 1111111111111111111111111111111111111111"
	hdrHead = "# branch.head main"
)

// P1 (V9, FR-GIT-35): 경로에 공백·개행·유니코드가 있어도 그대로 보존된다.
// -z 는 인용을 하지 않으므로 개행은 경로 문자 그대로 들어온다.
func TestParseStatusV2_PathsWithSpaceNewlineUnicode(t *testing.T) {
	in := nulRecords(
		hdrOid, hdrHead,
		"1 M. N... 100644 100644 100644 aaa bbb my file.txt",
		"1 .M N... 100644 100644 100644 aaa bbb line\nbreak.txt",
		"? 한글 폴더/파일 이름.txt",
	)
	st, err := ParseStatusV2(in)
	if err != nil {
		t.Fatalf("ParseStatusV2: %v", err)
	}
	if len(st.Staged) != 1 || st.Staged[0].Path != "my file.txt" {
		t.Fatalf("Staged = %+v", st.Staged)
	}
	if len(st.Changes) != 1 || st.Changes[0].Path != "line\nbreak.txt" {
		t.Fatalf("Changes = %+v", st.Changes)
	}
	if len(st.Untracked) != 1 || st.Untracked[0].Path != "한글 폴더/파일 이름.txt" {
		t.Fatalf("Untracked = %+v", st.Untracked)
	}
	if !st.Untracked[0].Untracked {
		t.Fatal("? 레코드의 Untracked 가 거짓이다")
	}
	if st.Total != 3 {
		t.Fatalf("Total = %d, want 3", st.Total)
	}
}

// P2 (V9, FR-GIT-36): rename·copy 는 origPath 를 다음 NUL 조각에서 소비한다.
// 조각 2개를 쓴다는 사실이 어긋나면 뒤 레코드가 전부 밀린다.
func TestParseStatusV2_RenameCopyConsumeTwoTokens(t *testing.T) {
	in := nulRecords(
		hdrOid, hdrHead,
		"2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt",
		"old name.txt",
		"2 .C N... 100644 100644 100644 aaa bbb C75 copy.txt",
		"src.txt",
		"? after.txt",
	)
	st, err := ParseStatusV2(in)
	if err != nil {
		t.Fatalf("ParseStatusV2: %v", err)
	}
	if len(st.Staged) != 1 {
		t.Fatalf("Staged = %+v", st.Staged)
	}
	r := st.Staged[0]
	if r.Path != "new name.txt" || r.OrigPath != "old name.txt" || r.Score != 100 || r.XY != "R." {
		t.Fatalf("rename = %+v", r)
	}
	if len(st.Changes) != 1 {
		t.Fatalf("Changes = %+v", st.Changes)
	}
	c := st.Changes[0]
	if c.Path != "copy.txt" || c.OrigPath != "src.txt" || c.Score != 75 {
		t.Fatalf("copy = %+v", c)
	}
	// origPath 조각을 삼키지 못하면 "old name.txt" 가 독립 레코드로 오해되고
	// after.txt 가 사라진다.
	if len(st.Untracked) != 1 || st.Untracked[0].Path != "after.txt" {
		t.Fatalf("Untracked = %+v", st.Untracked)
	}
	if st.Total != 3 {
		t.Fatalf("Total = %d, want 3", st.Total)
	}
}

// P3 (V9, FR-GIT-34): 한 파일이 Staged·Changes 양쪽에 든다. Total 은 합이 아니라
// 서로 다른 경로의 개수다 (FR-GIT-14 의 배지).
func TestParseStatusV2_BothSides(t *testing.T) {
	st, err := ParseStatusV2(nulRecords(hdrOid, hdrHead,
		"1 MM N... 100644 100644 100644 aaa bbb both.txt"))
	if err != nil {
		t.Fatalf("ParseStatusV2: %v", err)
	}
	if len(st.Staged) != 1 || len(st.Changes) != 1 {
		t.Fatalf("Staged=%d Changes=%d", len(st.Staged), len(st.Changes))
	}
	if !st.Staged[0].Staged || !st.Staged[0].Unstaged {
		t.Fatalf("entry = %+v", st.Staged[0])
	}
	if st.Total != 1 {
		t.Fatalf("Total = %d, want 1", st.Total)
	}
}

// P4 (V9, FR-GIT-37): u 레코드는 Conflicts 에만 든다. Staged·Changes 에 넣으면
// 충돌 파일이 스테이징 가능한 것처럼 보인다.
func TestParseStatusV2_ConflictOnly(t *testing.T) {
	st, err := ParseStatusV2(nulRecords(hdrOid, hdrHead,
		"u UU N... 100644 100644 100644 100644 h1 h2 h3 both modified.txt"))
	if err != nil {
		t.Fatalf("ParseStatusV2: %v", err)
	}
	if len(st.Conflicts) != 1 || st.Conflicts[0].Path != "both modified.txt" {
		t.Fatalf("Conflicts = %+v", st.Conflicts)
	}
	if !st.Conflicts[0].Conflict {
		t.Fatal("Conflict 가 거짓이다")
	}
	if len(st.Staged) != 0 || len(st.Changes) != 0 || len(st.Untracked) != 0 {
		t.Fatalf("충돌이 다른 그룹에도 들었다: staged=%d changes=%d untracked=%d",
			len(st.Staged), len(st.Changes), len(st.Untracked))
	}
	if st.Total != 1 {
		t.Fatalf("Total = %d, want 1", st.Total)
	}
}

// P5 (FR-GIT-33): 초기 커밋 전 / detached / upstream 없음 / branch.ab 없음.
func TestParseStatusV2_BranchHeaders(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		check func(*testing.T, Status)
	}{
		{"초기 저장소", nulRecords("# branch.oid (initial)", "# branch.head main"), func(t *testing.T, st Status) {
			if !st.Initial || st.Oid != "" || st.Branch != "main" {
				t.Fatalf("%+v", st)
			}
		}},
		{"detached", nulRecords(hdrOid, "# branch.head (detached)"), func(t *testing.T, st Status) {
			if !st.Detached || st.Branch != "" {
				t.Fatalf("%+v", st)
			}
		}},
		{"upstream 없음", nulRecords(hdrOid, hdrHead), func(t *testing.T, st Status) {
			if st.HasUpstream || st.Upstream != "" || st.Ahead != 0 || st.Behind != 0 {
				t.Fatalf("%+v", st)
			}
		}},
		{"upstream 있고 ab 있음", nulRecords(hdrOid, hdrHead,
			"# branch.upstream origin/main", "# branch.ab +2 -3"), func(t *testing.T, st Status) {
			if !st.HasUpstream || st.Upstream != "origin/main" || st.Ahead != 2 || st.Behind != 3 {
				t.Fatalf("%+v", st)
			}
		}},
		{"upstream 있고 ab 없음", nulRecords(hdrOid, hdrHead,
			"# branch.upstream origin/main"), func(t *testing.T, st Status) {
			if !st.HasUpstream || st.Ahead != 0 || st.Behind != 0 {
				t.Fatalf("%+v", st)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st, err := ParseStatusV2(tc.in)
			if err != nil {
				t.Fatalf("ParseStatusV2: %v", err)
			}
			tc.check(t, st)
		})
	}
}

// P6: 필드 수가 모자란 레코드는 오류다. 조용히 건너뛰면 목록이 조용히 틀린다.
func TestParseStatusV2_ShortRecordIsError(t *testing.T) {
	cases := map[string]string{
		"1 짧음":          nulRecords(hdrOid, hdrHead, "1 M. N... 100644"),
		"2 짧음":          nulRecords(hdrOid, hdrHead, "2 R. N... 100644 100644 100644 aaa bbb"),
		"u 짧음":          nulRecords(hdrOid, hdrHead, "u UU N... 100644 100644"),
		"2 origPath 없음": nulRecords(hdrOid, hdrHead, "2 R. N... 100644 100644 100644 aaa bbb R100 new.txt"),
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseStatusV2(in); err == nil {
				t.Fatal("오류를 기대했는데 nil 이다")
			}
		})
	}
}

// P7: 모르는 # 헤더는 조용히 무시한다 — git 이 헤더를 늘려도 깨지지 않아야 한다.
// 무시된 `!` 레코드도 마찬가지다 (--ignored 를 주지 않으므로 나오지 않아야 한다).
func TestParseStatusV2_UnknownHeaderIgnored(t *testing.T) {
	st, err := ParseStatusV2(nulRecords(
		hdrOid, hdrHead,
		"# branch.future something new",
		"# stash 3",
		"! ignored.txt",
		"? real.txt",
	))
	if err != nil {
		t.Fatalf("ParseStatusV2: %v", err)
	}
	if len(st.Untracked) != 1 || st.Untracked[0].Path != "real.txt" {
		t.Fatalf("Untracked = %+v", st.Untracked)
	}
	if st.Total != 1 {
		t.Fatalf("Total = %d, want 1", st.Total)
	}
}

// 각 그룹은 경로 오름차순이다 — UI 가 git 의 출력 순서에 의존하지 않게 한다.
func TestParseStatusV2_GroupsSorted(t *testing.T) {
	st, err := ParseStatusV2(nulRecords(hdrOid, hdrHead,
		"? z.txt", "? a.txt", "? m.txt"))
	if err != nil {
		t.Fatalf("ParseStatusV2: %v", err)
	}
	got := []string{st.Untracked[0].Path, st.Untracked[1].Path, st.Untracked[2].Path}
	want := []string{"a.txt", "m.txt", "z.txt"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("Untracked = %v, want %v", got, want)
		}
	}
}

// Service.Status 는 --ignored 를 주지 않는다. 무시된 파일은 관심 대상이 아니고
// 비용만 든다. 반대로 --untracked-files=all 은 **반드시** 준다 (FR-GIT-215) —
// git 기본값(normal)은 추적되지 않는 디렉터리를 한 줄로 접어 안의 파일을 하나도
// 열거하지 않는다.
func TestServiceStatus_Argv(t *testing.T) {
	var got []string
	s := core.New(core.WithRunner(func(_ context.Context, _ string, args []string) (core.Output, error) {
		got = args
		return core.Output{Stdout: nulRecords(hdrOid, hdrHead)}, nil
	}))
	st, err := StatusOf(s, context.Background(), absR)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	want := []string{"status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("argv = %q, want %q", got, want)
	}
	if st.Repo != absR {
		t.Fatalf("Repo = %q", st.Repo)
	}
}

func TestServiceStatus_PropagatesNotRepo(t *testing.T) {
	s := core.New(core.WithRunner(func(_ context.Context, _ string, _ []string) (core.Output, error) {
		return core.Output{ExitCode: 128, Stderr: "fatal: not a git repository"}, nil
	}))
	if _, err := StatusOf(s, context.Background(), absR); !errors.Is(err, core.ErrNotRepo) {
		t.Fatalf("err = %v, want ErrNotRepo", err)
	}
}

// ── 디렉터리 상태 항목 (GIT_DIR_ENTRY_SRS 묶음 S) ──
//
// git 이 파일이 아니라 **디렉터리 하나**를 상태의 단위로 보고하는 경우가 둘 있다.
// 중첩 저장소는 `--untracked-files=all` 로도 펴지지 않고(git 은 다른 저장소 안을
// 보지 않는다), 서브모듈은 gitlink 로 디렉터리를 그대로 추적한다. 둘의 문법이
// 서로 다르므로 판정은 여기 한 자리에서 한다 (D-DIR-1).

// V-DIR-1: 중첩 저장소는 `? nested/` 로 온다. 끝의 `/` 를 벗기고 Dir 로 옮긴다.
func TestParseStatusV2_UntrackedDirEntry(t *testing.T) {
	in := nulRecords(hdrOid, hdrHead, "? nested/", "? plain.txt")
	st, err := ParseStatusV2(in)
	if err != nil {
		t.Fatalf("ParseStatusV2: %v", err)
	}
	if len(st.Untracked) != 2 {
		t.Fatalf("Untracked = %+v", st.Untracked)
	}
	// 정렬은 경로 오름차순이다 — "nested" < "plain.txt".
	dir, file := st.Untracked[0], st.Untracked[1]
	if dir.Path != "nested" {
		t.Fatalf("dir.Path = %q, want %q (끝 슬래시를 벗긴다)", dir.Path, "nested")
	}
	if !dir.Dir {
		t.Fatal("중첩 저장소 항목의 Dir 이 거짓이다")
	}
	if dir.Sub != "" {
		t.Fatalf("dir.Sub = %q, want 빈 값 (중첩 저장소는 서브모듈이 아니다)", dir.Sub)
	}
	// V-DIR-3: 일반 미추적 파일은 그대로다.
	if file.Path != "plain.txt" || file.Dir {
		t.Fatalf("file = %+v, want {Path:plain.txt Dir:false}", file)
	}
}

// V-DIR-2: 등록된 서브모듈은 경로에 슬래시가 없고 sub 가 S 로 시작한다.
func TestParseStatusV2_SubmoduleIsDirEntry(t *testing.T) {
	in := nulRecords(hdrOid, hdrHead,
		"1 .M S.MU 160000 160000 160000 aaa bbb sub",
		"1 .M N... 100644 100644 100644 aaa bbb file.txt",
	)
	st, err := ParseStatusV2(in)
	if err != nil {
		t.Fatalf("ParseStatusV2: %v", err)
	}
	if len(st.Changes) != 2 {
		t.Fatalf("Changes = %+v", st.Changes)
	}
	var sub, file FileEntry
	for _, e := range st.Changes {
		if e.Path == "sub" {
			sub = e
		} else {
			file = e
		}
	}
	if !sub.Dir {
		t.Fatalf("서브모듈 항목의 Dir 이 거짓이다: %+v", sub)
	}
	if sub.Sub != "S.MU" {
		t.Fatalf("sub.Sub = %q, want S.MU", sub.Sub)
	}
	if file.Dir {
		t.Fatalf("일반 파일의 Dir 이 참이다: %+v", file)
	}
}

// V-DIR-5: 디렉터리 항목도 경로 하나로 센다 — 배지의 뜻이 바뀌지 않는다.
func TestParseStatusV2_DirEntryCountsAsOnePath(t *testing.T) {
	in := nulRecords(hdrOid, hdrHead,
		"1 .M S.MU 160000 160000 160000 aaa bbb sub",
		"? nested/",
	)
	st, err := ParseStatusV2(in)
	if err != nil {
		t.Fatalf("ParseStatusV2: %v", err)
	}
	if st.Total != 2 {
		t.Fatalf("Total = %d, want 2", st.Total)
	}
}

// 슬래시를 벗기는 것은 **미추적 디렉터리에만** 해당한다. 경로 안의 슬래시는
// 그대로다 — `a/b/` 는 `a/b` 이지 `a` 가 아니다.
func TestParseStatusV2_UntrackedNestedDirKeepsInnerSlashes(t *testing.T) {
	in := nulRecords(hdrOid, hdrHead, "? a/b/nested/")
	st, err := ParseStatusV2(in)
	if err != nil {
		t.Fatalf("ParseStatusV2: %v", err)
	}
	if len(st.Untracked) != 1 || st.Untracked[0].Path != "a/b/nested" {
		t.Fatalf("Untracked = %+v", st.Untracked)
	}
	if !st.Untracked[0].Dir {
		t.Fatal("Dir 이 거짓이다")
	}
}
