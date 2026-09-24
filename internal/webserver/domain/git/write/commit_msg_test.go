package write

import "testing"

// REPO_FIX 01 §7.7: amend 에서 "메시지가 직전과 같다" 는 git 의 cleanup=strip 과
// 같은 정규화로 비교한다.
func TestNormalizeCommitMessage(t *testing.T) {
	cases := []struct {
		name, prefix, a, b string
		same               bool
	}{
		{"줄 끝 공백", "#", "fix  \nbody\t", "fix\nbody", true},
		{"앞뒤 빈 줄", "#", "\n\nfix\n\n", "fix", true},
		{"연속 빈 줄", "#", "fix\n\n\n\nbody", "fix\n\nbody", true},
		{"주석 줄 제거", "#", "fix\n# 주석", "fix", true},
		{"다른 접두", ";", "fix\n; 주석\n# 남는다", "fix\n# 남는다", true},
		// commentChar=auto 면 주석 줄을 지우지 않는다(git 은 메시지에 없는 문자를
		// 골라 # 줄을 남긴다).
		{"auto 는 지우지 않음", "", "fix\n#12", "fix\n#13", false},
		{"내용이 다름", "#", "fix a", "fix b", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := NormalizeCommitMessage(c.a, c.prefix) == NormalizeCommitMessage(c.b, c.prefix)
			if got != c.same {
				t.Fatalf("같음 = %v, want %v (%q / %q)", got, c.same,
					NormalizeCommitMessage(c.a, c.prefix), NormalizeCommitMessage(c.b, c.prefix))
			}
		})
	}
}
