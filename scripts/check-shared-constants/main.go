// 공유 상수 대조 (SERVER_DRIVEN_ACTIONS_SRS FR-SDA-81 · K-j · TC-SDA-11).
//
// 서버가 보낼 수 없는 상수(연결이 끊긴 순간에 쓰는 코드·부팅 전에 필요한 값 등)는 화면과
// 서버에 두 벌로 남는다. 그 두 벌이 같은지 여기서 본다. 판정은 Check 이고, 탐침은
// check_test.go 에 있다.
//
//	go run ./scripts/check-shared-constants
package main

import (
	"fmt"
	"os"

	"dongminal/internal/webserver/domain/git/jobs"
)

func main() {
	s := Sources{Files: map[string]string{}, Locales: map[string]string{}, IndicatorKinds: jobs.IndicatorKinds()}
	for _, p := range Needed {
		raw, err := os.ReadFile(p)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		s.Files[p] = string(raw)
	}
	for _, l := range Locales {
		raw, err := os.ReadFile("web/js/i18n/" + l + ".js")
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		s.Locales[l] = string(raw)
	}
	if bad := Check(s); len(bad) > 0 {
		fmt.Fprintln(os.Stderr, "화면과 서버의 공유 상수가 어긋났습니다 — 두 쪽을 함께 고치세요:")
		for _, b := range bad {
			fmt.Fprintln(os.Stderr, "  "+b)
		}
		os.Exit(1)
	}
	fmt.Println("shared-constants ok (K9·K10·K12·K13·K17·K-h)")
}
