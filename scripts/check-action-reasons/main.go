// 동작 사유 문구 대조 (SERVER_DRIVEN_ACTIONS_SRS FR-SDA-8 · M-7).
//
// 서버의 판정이 낼 수 있는 사유 코드(action.Catalog)마다 화면 카탈로그에 ko·en 문구
// (`why.<코드>`)가 있어야 한다. 문구가 없으면 화면은 꺼진 버튼 옆에 날것의 코드를
// 보이고, 그것은 어느 컴파일러도 잡지 못한다.
//
//	go run ./scripts/check-action-reasons
package main

import (
	"fmt"
	"os"

	"dongminal/internal/webserver/action"
)

var locales = []string{"ko", "en"}

func main() {
	src := map[string]string{}
	for _, l := range locales {
		raw, err := os.ReadFile("web/js/i18n/" + l + ".js")
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		src[l] = string(raw)
	}
	missing := action.MissingPhrases(action.Catalog, src)
	if len(missing) > 0 {
		fmt.Fprintln(os.Stderr, "사유 코드에 문구가 없습니다 — web/js/i18n/<로케일>.js 에 더하세요:")
		for _, m := range missing {
			fmt.Fprintln(os.Stderr, "  "+m)
		}
		os.Exit(1)
	}
	fmt.Printf("action-reasons ok (%d actions)\n", len(action.Catalog))
}
