package core

import (
	"strings"
	"testing"
)

// FR-OPT-1-11 (DOM-M1): oid 는 sha1(40)·sha256(64) 둘 다다. 짧은 해시·다른 길이·
// 16진이 아닌 글자는 oid 가 아니다.
func TestIsOid(t *testing.T) {
	cases := []struct {
		s    string
		want bool
	}{
		{strings.Repeat("a", 40), true},
		{strings.Repeat("F", 64), true},
		{strings.Repeat("0", 64), true},
		{"", false},
		{"abc1234", false},
		{strings.Repeat("a", 41), false},
		{strings.Repeat("a", 63), false},
		{strings.Repeat("g", 40), false},
		{strings.Repeat("a", 39) + " ", false},
	}
	for _, c := range cases {
		if got := IsOid(c.s); got != c.want {
			t.Errorf("IsOid(%q) = %v, want %v", c.s, got, c.want)
		}
	}
}

func TestIsNullOid(t *testing.T) {
	cases := []struct {
		s    string
		want bool
	}{
		{strings.Repeat("0", 40), true},
		{strings.Repeat("0", 64), true},
		{strings.Repeat("0", 39) + "1", false},
		{strings.Repeat("0", 7), false},
		{"", false},
	}
	for _, c := range cases {
		if got := IsNullOid(c.s); got != c.want {
			t.Errorf("IsNullOid(%q) = %v, want %v", c.s, got, c.want)
		}
	}
}
