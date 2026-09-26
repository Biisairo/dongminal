package runtimebin

import (
	"bytes"
	"errors"
	"testing"
)

// FR-OPT-9-2 (SHR-15): 공통 인자 파서의 계약.

func TestArgSpec_ValueForms(t *testing.T) {
	var a, b string
	var on bool
	s := argSpec{vals: map[string]func(string) error{"--a": setStr(&a), "-b": setStr(&b)}, bools: map[string]*bool{"--on": &on}}
	help, e := s.parse([]string{"--a", "1", "-b=2", "--on"})
	if help || e != nil || a != "1" || b != "2" || !on {
		t.Fatalf("help=%v e=%v a=%q b=%q on=%v", help, e, a, b, on)
	}
}

func TestArgSpec_Errors(t *testing.T) {
	var a string
	bad := errors.New("bad")
	s := argSpec{vals: map[string]func(string) error{
		"--a": setStr(&a),
		"--n": func(string) error { return bad },
	}}
	cases := []struct {
		args []string
		kind argErrKind
		arg  string
	}{
		{[]string{"--a"}, argNeedsValue, "--a"},
		{[]string{"--zz"}, argUnknown, "--zz"},
		{[]string{"--n", "x", "--zz"}, argInvalid, "--n"},
	}
	for _, c := range cases {
		_, e := s.parse(c.args)
		if e == nil || e.kind != c.kind || e.arg != c.arg {
			t.Errorf("%q: got %+v, want kind=%d arg=%q", c.args, e, c.kind, c.arg)
		}
	}
}

func TestArgSpec_HelpStopsImmediately(t *testing.T) {
	s := argSpec{}
	help, e := s.parse([]string{"-h", "--bogus"})
	if !help || e != nil {
		t.Fatalf("help=%v e=%v", help, e)
	}
}

func TestArgSpec_RestModeCollectsPositionals(t *testing.T) {
	var rest []string
	var at string
	s := argSpec{vals: map[string]func(string) error{"--at": setStr(&at)}, rest: &rest, strictEq: true}
	help, e := s.parse([]string{"x", "-h", "--at=1", "y", "--", "--z"})
	if help || e != nil || at != "1" || len(rest) != 3 || rest[2] != "--z" {
		t.Fatalf("help=%v e=%v at=%q rest=%q", help, e, at, rest)
	}
	if _, e := s.parse([]string{"--at="}); e == nil || e.kind != argUnknown {
		t.Fatalf("strictEq: empty `--at=` must be unknown, got %+v", e)
	}
}

func TestArgSpec_RunReportsWithPrefix(t *testing.T) {
	var out, errw bytes.Buffer
	s := argSpec{help: "HELP\n"}
	if code, proceed := s.run("cmd", []string{"--x"}, &out, &errw); code != 2 || proceed || errw.String() != "cmd: unknown argument: --x\n" {
		t.Fatalf("code=%d proceed=%v stderr=%q", code, proceed, errw.String())
	}
	out.Reset()
	if code, proceed := s.run("cmd", []string{"--help"}, &out, &errw); code != 0 || proceed || out.String() != "HELP\n" {
		t.Fatalf("help: code=%d proceed=%v stdout=%q", code, proceed, out.String())
	}
}

// 의도한 동작 변경: list-workspace 도 다른 명령처럼 `--window=v`·`--tab=v` 를 받는다.
func TestListWorkspaceFlags_AcceptsEqualsForm(t *testing.T) {
	var out, errw bytes.Buffer
	f, code, proceed := parseListWorkspaceFlags([]string{"--window=w1", "--tab=t1"}, &out, &errw)
	if code != 0 || !proceed || f.windowFilter != "w1" || f.tabFilter != "t1" || errw.Len() != 0 {
		t.Fatalf("code=%d proceed=%v f=%+v stderr=%q", code, proceed, f, errw.String())
	}
}
