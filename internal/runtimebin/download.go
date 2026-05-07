package runtimebin

import (
	"fmt"
	"io"
	"path/filepath"
)

func runDownload(args []string, stdout, stderr io.Writer) int {
	var path string
	if len(args) > 0 {
		path = args[0]
	}
	if abs, err := filepath.Abs(path); err == nil && path != "" {
		path = abs
	}
	fmt.Fprintf(stdout, "\033]777;Download;%s\007", path)
	return 0
}
