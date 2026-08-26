package core

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

// 묶음 I — 커밋 (GIT_SRS §3A.2 FR-GIT-74~85, 검증 V33·V34·V35).

const commitFixtureMessage = "제목 줄\n\n본문 첫 줄\n본문 둘째 줄"

// S6 (V34, FR-GIT-77): 메시지는 **stdin 으로** 전달되고 argv 에 없다. 인자에 넣으면
// 프로세스 목록에 남는다.
func TestCommit_MessageViaStdinOnly(t *testing.T) {
	f := &writeFake{}
	s := New(WithWriteRunner(f.runner))

	if _, err := s.Commit(context.Background(), "/tmp/repo", CommitOpts{Message: commitFixtureMessage}); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	want := []string{"commit", "--file=-", "--cleanup=strip"}
	if fmt.Sprint(f.argvs[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", f.argvs[0], want)
	}
	for _, a := range f.argvs[0] {
		if strings.Contains(a, "제목 줄") || strings.Contains(a, "본문") {
			t.Fatalf("argv 에 메시지가 실렸다: %v", f.argvs[0])
		}
	}
	if f.stdins[0] != commitFixtureMessage {
		t.Fatalf("stdin = %q, want %q", f.stdins[0], commitFixtureMessage)
	}
}

// S7 (V34, §7.1 I6): 기록에는 **바이트 수만** 남는다. 메시지를 기록에 남기면 사람이
// 붙여넣은 것이 무엇이든 실행 로그로 흐른다.
func TestCommit_RecordKeepsOnlyStdinBytes(t *testing.T) {
	f := &writeFake{}
	s := New(WithWriteRunner(f.runner))

	if _, err := s.Commit(context.Background(), "/tmp/repo", CommitOpts{Message: commitFixtureMessage}); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	recs := s.Records(0)
	if len(recs) != 1 {
		t.Fatalf("기록 %d 개, want 1", len(recs))
	}
	rec := recs[0]
	if rec.StdinBytes != len(commitFixtureMessage) {
		t.Fatalf("StdinBytes = %d, want %d", rec.StdinBytes, len(commitFixtureMessage))
	}
	if strings.Contains(fmt.Sprint(rec), "제목 줄") {
		t.Fatalf("기록에 메시지가 남았다: %+v", rec)
	}
	// amend 는 되돌릴 수 있다 (HEAD@{1} 이 남는다) — 파괴적이 아니다.
	if rec.Destructive {
		t.Fatalf("commit 이 파괴적으로 기록됐다: %+v", rec)
	}
}

// S8 (V33, FR-GIT-79): 옵션 조합이 정확한 플래그를 만든다. 조합 명령을 만들지 않고
// 이 구조체 하나가 VSCode 의 20개 조합 명령을 대체한다.
func TestCommitOpts_Flags(t *testing.T) {
	cases := []struct {
		name string
		o    CommitOpts
		want []string
	}{
		{"기본", CommitOpts{}, []string{"commit", "--file=-", "--cleanup=strip"}},
		{"amend", CommitOpts{Amend: true}, []string{"commit", "--file=-", "--cleanup=strip", "--amend"}},
		{"signoff", CommitOpts{SignOff: true}, []string{"commit", "--file=-", "--cleanup=strip", "--signoff"}},
		{"no-verify", CommitOpts{NoVerify: true}, []string{"commit", "--file=-", "--cleanup=strip", "--no-verify"}},
		{"all", CommitOpts{All: true}, []string{"commit", "--file=-", "--cleanup=strip", "-a"}},
		{
			"전부", CommitOpts{Amend: true, SignOff: true, NoVerify: true, All: true},
			[]string{"commit", "--file=-", "--cleanup=strip", "--amend", "--signoff", "--no-verify", "-a"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &writeFake{}
			s := New(WithWriteRunner(f.runner))
			c.o.Message = "m"
			if _, err := s.Commit(context.Background(), "/tmp/repo", c.o); err != nil {
				t.Fatalf("Commit: %v", err)
			}
			if fmt.Sprint(f.argvs[0]) != fmt.Sprint(c.want) {
				t.Fatalf("argv = %v, want %v", f.argvs[0], c.want)
			}
			// `--no-edit` 을 주지 않는다 — `--file=-` 이 이미 메시지를 정하므로
			// 에디터가 열리지 않는다.
			for _, a := range f.argvs[0] {
				if a == "--no-edit" {
					t.Fatalf("--no-edit 이 붙었다: %v", f.argvs[0])
				}
			}
		})
	}
}

// S9 (V35, FR-GIT-82): undo 는 `reset --soft HEAD@{1}` 이다. `--hard` 는 워킹 트리를
// 지우므로 **여기에 나와서는 안 된다.**
func TestUndoLast_SoftResetOnly(t *testing.T) {
	f := &writeFake{}
	s := New(WithWriteRunner(f.runner))

	if _, err := s.UndoLast(context.Background(), "/tmp/repo"); err != nil {
		t.Fatalf("UndoLast: %v", err)
	}
	want := []string{"reset", "--soft", "HEAD@{1}"}
	if fmt.Sprint(f.argvs[0]) != fmt.Sprint(want) {
		t.Fatalf("argv = %v, want %v", f.argvs[0], want)
	}
	for _, a := range f.argvs[0] {
		if a == "--hard" || a == "--mixed" {
			t.Fatalf("%q 가 argv 에 있다: %v", a, f.argvs[0])
		}
	}
	// `--soft` 는 아무것도 지우지 않는다 — 파괴적이 아니다.
	if recs := s.Records(0); len(recs) != 1 || recs[0].Destructive {
		t.Fatalf("기록 = %+v", recs)
	}
}

// S9 (V35): 실제 저장소에서 undo 가 커밋만 되돌리고 index 를 남긴다.
func TestUndoLast_RealGitKeepsIndex(t *testing.T) {
	repo := tempRepo(t)
	s := New()
	ctx := context.Background()

	gitIn(t, repo, "commit", "--allow-empty", "-m", "second")
	before, err := s.Status(ctx, repo)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if _, err := s.UndoLast(ctx, repo); err != nil {
		t.Fatalf("UndoLast: %v", err)
	}
	after, err := s.Status(ctx, repo)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if after.Oid == before.Oid {
		t.Fatalf("HEAD 가 그대로다: %s", after.Oid)
	}
	if len(after.Staged) != 0 || len(after.Changes) != 0 {
		t.Fatalf("빈 커밋을 되돌렸는데 변경이 생겼다: %+v", after)
	}
}

// S10 (V33, FR-GIT-78): amend 토글이 채울 직전 커밋 메시지를 여러 줄 그대로 준다.
// 제목만 주면 본문이 사라지고, 토글 왕복이 손실 없이 되돌아오지 못한다.
func TestLastCommitMessage_MultiLine(t *testing.T) {
	repo := tempRepo(t)
	s := New()
	ctx := context.Background()

	gitIn(t, repo, "commit", "--allow-empty", "--cleanup=strip", "-m", commitFixtureMessage)
	got, err := s.LastCommitMessage(ctx, repo)
	if err != nil {
		t.Fatalf("LastCommitMessage: %v", err)
	}
	if got != commitFixtureMessage {
		t.Fatalf("message = %q, want %q", got, commitFixtureMessage)
	}
	if recs := s.Records(0); len(recs) != 1 || recs[0].Argv[0] != "log" {
		t.Fatalf("읽기 경로로 실행되지 않았다: %+v", recs)
	}
}

// S6·S10: 실제 git 으로 stdin 커밋의 왕복을 고정한다. 단위 픽스처는 내가 믿는
// 형식일 뿐이고, git 이 `--file=-` 을 다르게 다루면 여기서 먼저 깨져야 한다.
func TestCommit_RealGitRoundTrip(t *testing.T) {
	repo := tempRepoNoCommit(t)
	s := New()
	ctx := context.Background()

	if _, err := s.Commit(ctx, repo, CommitOpts{Message: commitFixtureMessage}); err != nil {
		t.Fatalf("Commit: %v", err)
	}
	got, err := s.LastCommitMessage(ctx, repo)
	if err != nil {
		t.Fatalf("LastCommitMessage: %v", err)
	}
	if got != commitFixtureMessage {
		t.Fatalf("message = %q, want %q", got, commitFixtureMessage)
	}
	st, err := s.Status(ctx, repo)
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if st.Initial || len(st.Staged) != 0 {
		t.Fatalf("커밋 후 status = %+v", st)
	}
}
