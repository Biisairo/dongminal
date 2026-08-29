package core

import "testing"

// FR-GIT-218 (V95): Console 은 argv 와 stderr 를 화면으로 내보낸다. 원격 URL 에
// 박힌 자격증명이 섞여 있으면 그대로 흘러간다 — FR-GIT-104 는 자격증명을 다루지
// 않겠다고 못박았고, 보안 기준 S.1·S.2 는 응답 본문에 토큰이 없어야 한다고 한다.
//
// userinfo 는 통째로 지운다. `user` 자리가 계정 이름인지 토큰인지 구분할 방법이
// 없기 때문이다.
func TestRedactSecrets(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://user:ghp_secret@github.com/o/r.git", "https://***@github.com/o/r.git"},
		{"https://ghp_secret@github.com/o/r.git", "https://***@github.com/o/r.git"},
		{"fatal: could not read from https://u:p@host/x", "fatal: could not read from https://***@host/x"},
		// 자격증명이 없는 URL 은 건드리지 않는다.
		{"https://github.com/o/r.git", "https://github.com/o/r.git"},
		// ssh 의 user@host 는 scheme 이 없어 비밀이 들어갈 자리가 없다.
		{"git@github.com:o/r.git", "git@github.com:o/r.git"},
		{"", ""},
	}
	for _, c := range cases {
		if got := RedactSecrets(c.in); got != c.want {
			t.Errorf("RedactSecrets(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// 마스킹 규칙은 한 벌이어야 한다. 두 이름이 서로 다른 결과를 내면 같은 URL 이
// 자리에 따라 다르게 보이고, 새 형태가 나왔을 때 한쪽만 고쳐진다.
func TestRedactSecretsMatchesSanitizeRemote(t *testing.T) {
	for _, s := range []string{
		"https://user:ghp_x@github.com/o/r.git",
		"https://ghp_x@github.com/o/r.git",
		"ssh://git@host:22/o/r.git",
		"git@github.com:o/r.git",
		"https://github.com/o/r.git",
		"fatal: could not read from https://u:p@host/x",
		"",
	} {
		if RedactSecrets(s) != SanitizeRemote(s) {
			t.Errorf("%q: RedactSecrets = %q, SanitizeRemote = %q", s, RedactSecrets(s), SanitizeRemote(s))
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
	if got.Argv[1] != "https://***@host/x" {
		t.Fatalf("argv = %q", got.Argv[1])
	}
	if got.Stderr != "remote: rejected https://***@host/x" {
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
