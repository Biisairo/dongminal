package peer

import "testing"

// 리뷰 S-8: Windows 의 최종 경로 접두를 뗀 값이 허용 폴더와 같은 표기여야 비교가 된다.
func TestTrimFinalPathPrefix(t *testing.T) {
	cases := map[string]string{
		`\\?\C:\work\app`:     `C:\work\app`,
		`\\?\UNC\srv\share\x`: `\\srv\share\x`,
		`C:\plain`:            `C:\plain`,
	}
	for in, want := range cases {
		if got := trimFinalPathPrefix(in); got != want {
			t.Errorf("%q → %q, 기대 %q", in, got, want)
		}
	}
}
