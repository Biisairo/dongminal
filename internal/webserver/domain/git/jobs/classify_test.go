package jobs

import (
	"errors"
	"fmt"
	"reflect"
	"testing"

	"dongminal/internal/webserver/domain/git/core"
)

// FR-OPT-9-5 (DOM-32): finish 에서 떼어낸 결말 분류는 순수 함수다.
func TestClassifyOutcome(t *testing.T) {
	timeout := fmt.Errorf("%w: 상한", core.ErrTimeout)
	cases := []struct {
		name               string
		kind               string
		canceled, shutdown bool
		runErr             error
		exit               int
		tail               string
		want               Job
	}{
		{name: "성공", kind: "commit", want: Job{Kind: "commit", Done: true}},
		{name: "exit 만의 실패", kind: "merge", exit: 1, tail: "! [rejected]",
			want: Job{Kind: "merge", Done: true, ExitCode: 1, StderrTail: "! [rejected]", Err: "git merge 가 exit 1 로 끝났다"}},
		{name: "서버 종료는 취소가 아니다", kind: "push", canceled: true, shutdown: true, exit: 1, tail: "Authentication failed",
			want: Job{Kind: "push", Done: true, ExitCode: 1, StderrTail: "Authentication failed", ErrorCode: ErrorServerShutdown,
				Err: "서버 종료로 중단했다 — 일부가 적용됐을 수 있다"}},
		{name: "원격 취소", kind: "fetch", canceled: true,
			want: Job{Kind: "fetch", Done: true, Canceled: true, Err: "취소했다. 원격에 일부가 적용됐을 수 있다"}},
		{name: "로컬 취소", kind: "commit", canceled: true,
			want: Job{Kind: "commit", Done: true, Canceled: true, Err: "취소했다. 일부가 적용됐을 수 있다 — 상태를 확인하라"}},
		{name: "시한", kind: "commit", runErr: timeout,
			want: Job{Kind: "commit", Done: true, ErrorCode: ErrorTimeout, Err: core.SanitizeRemote(timeout.Error())}},
		{name: "실행기 오류", kind: "commit", runErr: errors.New("boom"),
			want: Job{Kind: "commit", Done: true, Err: "boom"}},
		{name: "원격 거부는 선택지를 싣는다", kind: "push", exit: 1, tail: "! [rejected] main -> main (non-fast-forward)",
			want: Job{Kind: "push", Done: true, ExitCode: 1, StderrTail: "! [rejected] main -> main (non-fast-forward)",
				Err: "git push 가 exit 1 로 끝났다", Rejected: true, Options: RemoteRejectOptions}},
	}
	for _, c := range cases {
		got := classifyOutcome(Job{Kind: c.kind}, c.canceled, c.shutdown, c.runErr, c.exit, c.tail)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n got %+v\nwant %+v", c.name, got, c.want)
		}
	}
}

// 선택지는 사본이다 — 공개된 Job 이 전역 표를 공유하면 한쪽 수정이 다른 쪽에 샌다.
func TestClassifyOutcome_OptionsAreCopied(t *testing.T) {
	got := classifyOutcome(Job{Kind: "push"}, false, false, nil, 1, "non-fast-forward")
	if len(got.Options) == 0 || &got.Options[0] == &RemoteRejectOptions[0] {
		t.Fatal("Options must be a fresh copy")
	}
}
