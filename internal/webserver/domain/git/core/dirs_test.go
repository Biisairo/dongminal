package core

import (
	"context"
	"errors"
	"testing"
)

// P17: GitDirs 는 rev-parse 한 번으로 두 줄을 얻는다. 둘째 줄이 상대경로면
// repo 기준으로 절대화한다 (git 2.50 은 `.git` 을 준다).
func TestGitDirs(t *testing.T) {
	cases := []struct {
		name       string
		out        Output
		wantGit    string
		wantCommon string
		wantErr    error
	}{
		{"둘째 줄 상대경로", Output{Stdout: "/r/.git\n.git\n"}, "/r/.git", "/r/.git", nil},
		{"worktree — 둘이 다르다", Output{Stdout: "/r/.git/worktrees/w\n/r/.git\n"}, "/r/.git/worktrees/w", "/r/.git", nil},
		{"빈 출력", Output{Stdout: "\n"}, "", "", ErrNotRepo},
		{"저장소 아님", Output{ExitCode: 128, Stderr: "fatal: not a git repository"}, "", "", ErrNotRepo},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var gotArgs []string
			s := New(WithRunner(func(_ context.Context, _ string, args []string) (Output, error) {
				gotArgs = args
				return tc.out, nil
			}))
			gitDir, commonDir, err := s.GitDirs(context.Background(), "/r")
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("GitDirs: %v", err)
			}
			if gitDir != tc.wantGit || commonDir != tc.wantCommon {
				t.Fatalf("gitDir=%q commonDir=%q, want %q %q", gitDir, commonDir, tc.wantGit, tc.wantCommon)
			}
			want := "rev-parse --absolute-git-dir --git-common-dir"
			if len(gotArgs) != 3 || gotArgs[0]+" "+gotArgs[1]+" "+gotArgs[2] != want {
				t.Fatalf("argv = %q, want %q", gotArgs, want)
			}
		})
	}
}
