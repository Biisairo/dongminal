package dmenv

import (
	"testing"
	"time"
)

func TestMillisEnv(t *testing.T) {
	const name = "DONGMINAL_TEST_MILLIS"
	def := 3 * time.Second
	cases := []struct {
		v    string
		min  int
		want time.Duration
	}{
		{"", 0, def},
		{"abc", 0, def},
		{"-1", 0, def},
		{"0", 0, 0},
		{"0", 1, def},
		{"250", 1, 250 * time.Millisecond},
	}
	for _, c := range cases {
		t.Setenv(name, c.v)
		if got := MillisEnv(name, def, c.min); got != c.want {
			t.Errorf("%q min=%d → %s (want %s)", c.v, c.min, got, c.want)
		}
	}
}

func TestFlagEnv(t *testing.T) {
	const name = "DONGMINAL_TEST_FLAG"
	for v, want := range map[string]bool{"": false, "0": false, "true": false, "1": true} {
		t.Setenv(name, v)
		if got := FlagEnv(name); got != want {
			t.Errorf("%q → %v", v, got)
		}
	}
}
