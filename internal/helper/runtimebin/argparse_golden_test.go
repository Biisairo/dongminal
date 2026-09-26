package runtimebin

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"dongminal/internal/shared/dmenv"
)

// FR-OPT-9-2 (SHR-15): dmctl 인자 파서 넷을 한 벌로 모은 뒤에도 **출력 바이트와 종료
// 코드가 그대로**인지를 골든으로 고정한다. 골든은 통일 전 파서가 만든 것이다.
// 의도한 변경(list-workspace 의 `--k=v`)은 골든이 아니라 따로 검사한다.

var updateArgGolden = flag.Bool("update-arg-golden", false, "rewrite testdata/argparse.golden")

type goldenParseCase struct {
	parser string
	args   []string
}

var goldenParseCases = func() []goldenParseCase {
	var cs []goldenParseCase
	add := func(p string, argss ...[]string) {
		for _, a := range argss {
			cs = append(cs, goldenParseCase{p, a})
		}
	}
	common := [][]string{
		nil, {"-h"}, {"--help"}, {"--json"}, {"--json", "-h", "--bogus"}, {"--bogus", "-h"},
		{"--json=1"}, {"="}, {"-"}, {"x"}, {"--"},
	}
	add("list-workspace", common...)
	add("list-workspace",
		[]string{"--window"}, []string{"--tab"}, []string{"--window", "a", "--tab", "b"},
		[]string{"--window", "--json"}, []string{"--json", "--window", "w"},
	)
	for _, cmd := range []string{"status", "wait"} {
		add(cmd, common...)
		add(cmd,
			[]string{"--at"}, []string{"--at", "t1"}, []string{"--at=t1"}, []string{"--at="}, []string{"-l", "t1"},
			[]string{"-l=t1"}, []string{"-l="}, []string{"--at=a=b"}, []string{"--member"}, []string{"--member", "m1"},
			[]string{"--member=m1"}, []string{"--at", "t1", "--member", "m1"}, []string{"--at", "--json"},
			[]string{"--for"}, []string{"--for", "ready", "--at", "t"}, []string{"--for=done", "--at", "t"},
			[]string{"--for", "bad", "--at", "t"}, []string{"--at", "t"},
			[]string{"--timeout-ms"}, []string{"--timeout-ms", "abc", "--bogus"}, []string{"--timeout-ms=0", "--at", "t"},
			[]string{"--timeout-ms", "-5", "--at", "t"}, []string{"--timeout-ms=100", "--for", "ready", "--at", "t"},
			[]string{"--timeout-ms", "100", "--for", "done", "--at", "t", "--json"},
		)
	}
	add("run", common...)
	add("run",
		[]string{"--run"}, []string{"--run", "r1", "--member", "m", "--force", "--headless", "--keep-worktrees",
			"--keep-tools", "--json", "--text"},
		[]string{"--run=r1", "--role=x", "-l=t", "--timeout-ms=5"}, []string{"--run="}, []string{"-l"},
		[]string{"--force=1"}, []string{"--at", "--brief"}, []string{"--brief", "-"}, []string{"--bogus=1"},
		[]string{"--objective", "o", "--projection", "p", "--isolation", "i", "--window", "w", "--outcome", "o",
			"--summary", "s", "--files", "f", "--base", "b", "--agent", "a", "--model", "m"},
	)
	add("dmctl", common...)
	add("dmctl",
		[]string{"--at"}, []string{"--at", "1.2"}, []string{"--at="}, []string{"--at=1"}, []string{"-l="}, []string{"-l=2"},
		[]string{"--name"}, []string{"--name="}, []string{"--name=n"}, []string{"--name", "n", "a", "b"},
		[]string{"--sandbox", "p", "--workdir", "w", "--cwd", "c"}, []string{"--sandbox=", "x"},
		[]string{"--sandbox=p", "--workdir=w", "--cwd=c"}, []string{"--workdir="}, []string{"--cwd="},
		[]string{"--no-focus", "-n", "--auto", "--force", "--background"}, []string{"--no-focus=1"},
		[]string{"a", "--", "--at", "b"}, []string{"-h", "a"}, []string{"a", "--bogus"}, []string{"-5"},
	)
	return cs
}()

func renderParse(c goldenParseCase) string {
	var out, errw bytes.Buffer
	var res string
	switch c.parser {
	case "list-workspace":
		f, code, proceed := parseListWorkspaceFlags(c.args, &out, &errw)
		res = fmt.Sprintf("code=%d proceed=%v f=%+v", code, proceed, f)
	case "status", "wait":
		f, code, proceed := parseStatusFlags(c.parser, c.args, c.parser == "wait", &out, &errw)
		res = fmt.Sprintf("code=%d proceed=%v f=%+v", code, proceed, f)
	case "run":
		f, code, proceed := parseRunFlags("sub", c.args, &out, &errw)
		res = fmt.Sprintf("code=%d proceed=%v f=%+v", code, proceed, f)
	case "dmctl":
		p, err := parseDmctlFlags(c.args)
		res = fmt.Sprintf("err=%v p=%+v", err, p)
	}
	stdout := out.String()
	if len(stdout) > 40 {
		stdout = fmt.Sprintf("<%d bytes, sum %x>", len(stdout), fnv32(stdout))
	}
	return fmt.Sprintf("%s %q\n  %s\n  stdout=%q\n  stderr=%q\n", c.parser, c.args, res, stdout, errw.String())
}

func fnv32(s string) uint32 {
	h := uint32(2166136261)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	return h
}

func TestArgParseGolden(t *testing.T) {
	t.Setenv(dmenv.EnvToolID, "self-tool")
	var b strings.Builder
	for _, c := range goldenParseCases {
		b.WriteString(renderParse(c))
	}
	path := filepath.Join("testdata", "argparse.golden")
	if *updateArgGolden {
		if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := b.String(); got != string(want) {
		gl, wl := strings.Split(got, "\n"), strings.Split(string(want), "\n")
		for i := 0; i < len(gl) && i < len(wl); i++ {
			if gl[i] != wl[i] {
				t.Fatalf("golden mismatch at line %d:\n got %s\nwant %s", i+1, gl[i], wl[i])
			}
		}
		t.Fatalf("golden length mismatch: got %d lines want %d", len(gl), len(wl))
	}
}
