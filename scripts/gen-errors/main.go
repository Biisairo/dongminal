// 오류 카탈로그 생성기 (ERROR_CONTRACT_SRS FR-ERR-8).
//
//	go run ./scripts/gen-errors          # docs/external/errors.md 를 쓴다
//	go run ./scripts/gen-errors -check   # 어긋나면 exit 1 (CI 가 부른다)
package main

import (
	"flag"
	"fmt"
	"os"

	"dongminal/internal/ctl/errdoc"
)

const out = "docs/external/errors.md"

func main() {
	check := flag.Bool("check", false, "고치지 않고 어긋남만 본다")
	flag.Parse()

	body, err := errdoc.Render()
	if err != nil {
		fmt.Fprintln(os.Stderr, "카탈로그를 만들지 못했습니다:", err)
		os.Exit(1)
	}
	if *check {
		cur, err := os.ReadFile(out)
		if err != nil {
			fmt.Fprintf(os.Stderr, "%s 가 없습니다 — `go run ./scripts/gen-errors` 를 돌리세요\n", out)
			os.Exit(1)
		}
		if string(cur) != body {
			fmt.Fprintf(os.Stderr, "%s 가 codes_doc.go 와 어긋납니다.\n", out)
			fmt.Fprintln(os.Stderr, "  `go run ./scripts/gen-errors` 를 돌려 다시 만드세요.")
			fmt.Fprintln(os.Stderr, "  (이 파일은 생성물입니다 — 직접 고치지 마세요.)")
			os.Exit(1)
		}
		fmt.Printf("error-docs ok (%s)\n", out)
		return
	}
	if err := os.WriteFile(out, []byte(body), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("✅ %s\n", out)
}
