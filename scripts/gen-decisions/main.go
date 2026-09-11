// 결정 색인 생성기 (M5 `G8-1`).
//
//	go run ./scripts/gen-decisions          # docs/internal/decisions.md 를 쓴다
//	go run ./scripts/gen-decisions -check   # 어긋나면 exit 1 (CI 가 부른다)
package main

import (
	"flag"
	"fmt"
	"os"

	"dongminal/internal/ctl/decidx"
)

const (
	srcDir = "docs/internal"
	out    = "docs/internal/decisions.md"
)

func main() {
	check := flag.Bool("check", false, "고치지 않고 어긋남만 본다")
	flag.Parse()

	entries, err := decidx.Collect(srcDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	body := decidx.Render(entries)

	if *check {
		cur, err := os.ReadFile(out)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s 가 없습니다 — `go run ./scripts/gen-decisions` 를 돌리세요\n", out)
			os.Exit(1)
		}
		if string(cur) != body {
			fmt.Fprintf(os.Stderr, "%s 가 SRS 의 결정과 어긋납니다.\n", out)
			fmt.Fprintln(os.Stderr, "  `go run ./scripts/gen-decisions` 를 돌려 다시 만드세요.")
			fmt.Fprintln(os.Stderr, "  (이 파일은 생성물입니다 — 직접 고치지 마세요.)")
			os.Exit(1)
		}
		fmt.Printf("decisions ok (%d건)\n", len(entries))
		return
	}
	if err := os.WriteFile(out, []byte(body), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("✅ %s (%d건)\n", out, len(entries))
}
