package gittest

import (
	"strings"
	"testing"
)

func TestRepo_HasOneCommitOnMain(t *testing.T) {
	dir := Repo(t)
	if got := Run(t, dir, "rev-parse", "--abbrev-ref", "HEAD"); got != "main" {
		t.Fatalf("branch=%q", got)
	}
	if got := Run(t, dir, "log", "--oneline"); strings.Count(got, "\n") != 0 || got == "" {
		t.Fatalf("log=%q", got)
	}
	if got := Run(t, dir, "rev-parse", "--show-toplevel"); got != dir {
		t.Fatalf("toplevel %q != %q — 심볼릭 링크가 풀리지 않았다", got, dir)
	}
}
