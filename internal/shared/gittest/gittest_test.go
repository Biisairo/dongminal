package gittest

import (
	"path/filepath"
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
	// git 은 toplevel 을 **언제나 슬래시**로 답한다 — Windows 에서도 그렇다.
	// 재려는 것은 심볼릭 링크가 풀렸는가이지 구분자가 무엇인가가 아니므로
	// 둘을 같은 형태로 맞춰 견준다 (WINDOWS_TEST_PARITY_SRS 의 부류).
	if got := Run(t, dir, "rev-parse", "--show-toplevel"); got != filepath.ToSlash(dir) {
		t.Fatalf("toplevel %q != %q — 심볼릭 링크가 풀리지 않았다", got, dir)
	}
}
