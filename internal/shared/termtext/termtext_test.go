package termtext

import "testing"

// REFACTOR3_DEDUP_GO_SRS TC-RDG-41: 제어 문자와 Cf(bidi 재정렬·zero-width)를 지우고 나머지는 그대로 둔다.
func TestStrip(t *testing.T) {
	in := "a\x07b\u202ec\u200bd\x7fe\u0085f 가\t\n한"
	if got, want := Strip(in), "abcdef 가한"; got != want {
		t.Fatalf("Strip=%q want %q", got, want)
	}
	if got := Strip("동민#0427 ok"); got != "동민#0427 ok" {
		t.Fatalf("Strip 이 보이는 글자를 바꿨다: %q", got)
	}
}

func TestHidden(t *testing.T) {
	for _, r := range []rune{'\x00', '\n', '\x1b', '\u202e', '\u200b', '\ufeff'} {
		if !Hidden(r) {
			t.Errorf("Hidden(%U)=false", r)
		}
	}
	for _, r := range []rune{'a', ' ', '가', '\ufffd', '#'} {
		if Hidden(r) {
			t.Errorf("Hidden(%U)=true", r)
		}
	}
}

func TestLine(t *testing.T) {
	cases := []struct {
		s    string
		max  int
		want bool
	}{
		{"동민", 64, true},
		{"", 64, true},
		{"abcd", 3, false},
		{"a\nb", 64, false},
		{"a\u202eb", 64, false},
		{"a\xffb", 64, false},
	}
	for _, c := range cases {
		if got := Line(c.s, c.max); got != c.want {
			t.Errorf("Line(%q,%d)=%v want %v", c.s, c.max, got, c.want)
		}
	}
}

func TestCut(t *testing.T) {
	cases := []struct {
		s    string
		n    int
		want string
	}{
		{"0123456789abcdef0123", FPShort, "0123456789ab"},
		{"0123456789abcdef0123", FPShown, "0123456789abcdef"},
		{"abc", FPShort, "abc"},
		{"가나다", 4, "가"},
		{"가나다", 6, "가나"},
		{"가", 2, ""},
	}
	for _, c := range cases {
		if got := Cut(c.s, c.n); got != c.want {
			t.Errorf("Cut(%q,%d)=%q want %q", c.s, c.n, got, c.want)
		}
	}
}
