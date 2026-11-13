//go:build !windows

package platform

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// CLAUDE_ACCOUNTS_SRS FR-CAC-75: 프로세스 명령줄 목록.

func TestCommandLinesIncludesSelf(t *testing.T) {
	lines, err := CommandLines()
	if err != nil {
		t.Fatal(err)
	}
	self := filepath.Base(os.Args[0])
	for _, l := range lines {
		if strings.Contains(l, self) {
			return
		}
	}
	t.Fatalf("own process %q not listed (%d lines)", self, len(lines))
}

func TestParseCommandLines(t *testing.T) {
	got := parseCommandLines([]byte("  /usr/bin/cswap auto\n\n/bin/zsh -l  \n"))
	if len(got) != 2 || got[0] != "/usr/bin/cswap auto" || got[1] != "/bin/zsh -l" {
		t.Fatalf("%q", got)
	}
}

func TestCommandLinesRunFailure(t *testing.T) {
	_, err := commandLinesWith(func(string, ...string) ([]byte, error) { return nil, errors.New("no ps") })
	if err == nil {
		t.Fatal("error is passed through")
	}
}
