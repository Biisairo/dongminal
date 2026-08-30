package write

import (
	"context"
	"errors"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/query"
)

// 묶음 A — 진행 중 작업의 출구 (GIT_ACTIONS_SRS §3.1 FR-GIT-252, 검증 V175·V176).

// A6: 종류마다 git 이 실제로 받는 하위 명령이 나온다. **merge 에는 skip 이 없다** —
// 없는 것을 목록에 넣으면 화면이 누를 수 있는 것처럼 보인다.
func TestOperationArgs_PerKind(t *testing.T) {
	cases := []struct {
		kind, action string
		want         []string
	}{
		{query.OpMerge, OpContinue, []string{"merge", "--continue"}},
		{query.OpMerge, OpAbort, []string{"merge", "--abort"}},
		{query.OpRebase, OpContinue, []string{"rebase", "--continue"}},
		{query.OpRebase, OpAbort, []string{"rebase", "--abort"}},
		{query.OpRebase, OpSkip, []string{"rebase", "--skip"}},
		{query.OpCherryPick, OpContinue, []string{"cherry-pick", "--continue"}},
		{query.OpCherryPick, OpAbort, []string{"cherry-pick", "--abort"}},
		{query.OpCherryPick, OpSkip, []string{"cherry-pick", "--skip"}},
		{query.OpRevert, OpContinue, []string{"revert", "--continue"}},
		{query.OpRevert, OpAbort, []string{"revert", "--abort"}},
		{query.OpRevert, OpSkip, []string{"revert", "--skip"}},
	}
	for _, tc := range cases {
		got, err := OperationArgs(tc.kind, tc.action)
		if err != nil {
			t.Fatalf("%s/%s: %v", tc.kind, tc.action, err)
		}
		if len(got) != len(tc.want) {
			t.Fatalf("%s/%s: argv = %v, want %v", tc.kind, tc.action, got, tc.want)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("%s/%s: argv = %v, want %v", tc.kind, tc.action, got, tc.want)
			}
		}
	}
}

// A7: 모르는 종류·동작과 **merge 의 skip** 은 실행 전에 거부된다. git 에 맡기면
// exit 128 의 문구로만 알 수 있고, 서버가 400 으로 답할 수 없다.
func TestOperationArgs_Rejects(t *testing.T) {
	cases := []struct{ kind, action string }{
		{query.OpNone, OpAbort},
		{"", ""},
		{"bisect", OpAbort},
		{query.OpMerge, OpSkip},
		{query.OpRebase, "start"},
		{query.OpRebase, "--abort"},
	}
	for _, tc := range cases {
		if argv, err := OperationArgs(tc.kind, tc.action); err == nil {
			t.Fatalf("%q/%q 가 거부되지 않았다: %v", tc.kind, tc.action, argv)
		} else if !errors.Is(err, ErrOperation) {
			t.Fatalf("%q/%q 의 오류가 ErrOperation 이 아니다: %v", tc.kind, tc.action, err)
		}
	}
}

// A9 (FR-GIT-95): 실행은 ExecWrite 하나만 지나고, 선언한 파괴 여부가 **기록에**
// 그대로 남는다 — 기록이 곧 근거다.
func TestOperation_DestructiveInRecord(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		action string
		want   bool
	}{
		{OpContinue, false},
		{OpSkip, false},
		{OpAbort, true},
	} {
		f := &writeFake{}
		s := core.New(core.WithWriteRunner(f.runner))
		if _, err := Operation(s, ctx, absTmpRepo, query.OpRebase, tc.action); err != nil {
			t.Fatalf("%s: %v", tc.action, err)
		}
		recs := s.Records(0)
		if len(recs) == 0 {
			t.Fatalf("%s: 기록이 없다", tc.action)
		}
		if got := recs[len(recs)-1].Destructive; got != tc.want {
			t.Fatalf("%s: Destructive = %v, want %v", tc.action, got, tc.want)
		}
	}
}
