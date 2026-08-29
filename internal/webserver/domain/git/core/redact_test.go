package core

import "testing"

// FR-GIT-218 (V95): Console 은 argv 와 stderr 를 화면으로 내보낸다. 원격 URL 에
// 박힌 자격증명이 섞여 있으면 그대로 흘러간다 — FR-GIT-104 는 자격증명을 다루지
// 않겠다고 못박았고, 보안 기준 S.1·S.2 는 응답 본문에 토큰이 없어야 한다고 한다.
func TestRedactSecrets(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://user:ghp_secret@github.com/o/r.git", "https://user:***@github.com/o/r.git"},
		{"https://ghp_secret@github.com/o/r.git", "https://***@github.com/o/r.git"},
		{"fatal: could not read from https://u:p@host/x", "fatal: could not read from https://u:***@host/x"},
		// 자격증명이 없는 URL 은 건드리지 않는다.
		{"https://github.com/o/r.git", "https://github.com/o/r.git"},
		// ssh 의 user@host 는 비밀이 아니다 — 지우면 사용자가 어느 계정인지 잃는다.
		{"git@github.com:o/r.git", "git@github.com:o/r.git"},
		{"", ""},
	}
	for _, c := range cases {
		if got := RedactSecrets(c.in); got != c.want {
			t.Errorf("RedactSecrets(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 기록 한 줄 전체가 걸러져 나가야 한다 — 한 필드만 지우면 다른 필드로 샌다.
func TestRecordRedacted(t *testing.T) {
	r := Record{
		Argv:   []string{"push", "https://u:tok@host/x", "main"},
		Cwd:    absR,
		Stderr: "remote: rejected https://u:tok@host/x",
	}
	got := r.Redacted()
	if got.Argv[1] != "https://u:***@host/x" {
		t.Fatalf("argv = %q", got.Argv[1])
	}
	if got.Stderr != "remote: rejected https://u:***@host/x" {
		t.Fatalf("stderr = %q", got.Stderr)
	}
	// 원본을 건드리지 않는다 — 기록은 링 버퍼에 남아 다시 읽힌다.
	if r.Argv[1] != "https://u:tok@host/x" {
		t.Fatalf("원본 argv 가 바뀌었다: %q", r.Argv[1])
	}
}

// FR-GIT-218: Console 은 폴링을 기본에서 감춘다. 쓰기 판정을 새로 만들지 않고
// writeCommands(FR-GIT-95) 를 그대로 딛는지 본다 — 두 곳에서 다르게 판정하면
// 화면이 감춘 것과 실행 경로가 막는 것이 어긋난다.
func TestRecordCarriesWriteFlag(t *testing.T) {
	for _, c := range []struct {
		argv  []string
		write bool
	}{
		{[]string{"status", "--porcelain=v2"}, false},
		{[]string{"rev-parse", "--show-toplevel"}, false},
		{[]string{"add", "a.txt"}, true},
		{[]string{"commit", "-F", "-"}, true},
		{[]string{"clean", "-f"}, true},
		{[]string{"stash", "list"}, true}, // I7: stash 는 목록도 쓰기 경로다
		{nil, false},
	} {
		got := newRecord(absR, c.argv, Output{}, nil)
		if got.Write != c.write {
			t.Errorf("newRecord(%v).Write = %v, want %v", c.argv, got.Write, c.write)
		}
	}
}
