package core

import (
	"testing"
)

// R5 (V43, FR-GIT-104): sanitizeRemote 가 URL 의 자격증명을 지운다.
func TestSanitizeRemote(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://u:p@host/x.git", "https://***@host/x.git"},
		{"remote: https://ghp_abcdef@github.com/o/r.git 에 밀었다", "remote: https://***@github.com/o/r.git 에 밀었다"},
		{"ssh://git@host:22/o/r.git", "ssh://***@host:22/o/r.git"},
		{"git@github.com:o/r.git", "git@github.com:o/r.git"},         // scp 형태는 비밀이 들어갈 자리가 없다
		{"https://github.com/o/r.git", "https://github.com/o/r.git"}, // userinfo 가 없다
		{"진행 중 50%", "진행 중 50%"},
	}
	for _, c := range cases {
		if got := SanitizeRemote(c.in); got != c.want {
			t.Errorf("SanitizeRemote(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
