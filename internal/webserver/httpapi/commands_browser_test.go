package httpapi

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"dongminal/internal/webserver/hub"
)

// 브라우저의 _execRemote 가 명시적으로 처리하는 action 은 모두 서버
// 화이트리스트에 있어야 한다. 없으면 POST /api/commands 가 400 으로 거부해
// 브라우저 코드에 도달하지 못한다.
//
// P6 의 detach CLI 가 이 상태로 배선됐다. detach_test.go 는 httptest 스텁
// 서버에 POST 하므로 어떤 action 이든 통과해 결함이 드러나지 않았다.
// 생산자(브라우저)와 검증자(서버)를 직접 대조해 재발을 막는다.
func TestAllowedCmdActions_CoversBrowserHandled(t *testing.T) {
	src, err := os.ReadFile("../../../web/js/core/app-cmd.js")
	if err != nil {
		t.Fatalf("app-cmd.js 읽기 실패: %v", err)
	}
	body := execRemoteBody(t, string(src))

	re := regexp.MustCompile(`action==='([A-Za-z]+)'`)
	seen := map[string]bool{}
	for _, m := range re.FindAllStringSubmatch(body, -1) {
		seen[m[1]] = true
	}
	if len(seen) < 5 {
		t.Fatalf("_execRemote 에서 추출한 action 이 %d 개뿐 — 파싱이 깨졌다", len(seen))
	}
	for a := range seen {
		if !hub.AllowedCmdActions[a] {
			t.Errorf("브라우저는 %q 를 처리하지만 hub.AllowedCmdActions 에 없다 — /api/commands 가 400 으로 거부한다", a)
		}
	}
}

// execRemoteBody는 app-cmd.js 에서 _execRemote 메서드 본문만 잘라낸다.
// 다음 메서드 선언(_resolveLocation)을 경계로 삼는다.
func execRemoteBody(t *testing.T, src string) string {
	t.Helper()
	start := strings.Index(src, "_execRemote(action, args)")
	if start < 0 {
		t.Fatal("app-cmd.js 에서 _execRemote 를 찾지 못했다 — 테스트를 갱신하라")
	}
	end := strings.Index(src[start:], "_resolveLocation(loc)")
	if end < 0 {
		t.Fatal("app-cmd.js 에서 _execRemote 의 끝 경계를 찾지 못했다 — 테스트를 갱신하라")
	}
	return src[start : start+end]
}

// detach CLI 와 dmctl 이 보내는 action 도 화이트리스트에 있어야 한다.
// 값을 코드에서 가져오지 않고 여기에 고정하는 이유는, 일괄 개명이 양쪽을
// 동시에 바꿔 자기 정합적으로 틀린 계약이 되는 것을 막기 위함이다.
func TestAllowedCmdActions_CoversCLIProducers(t *testing.T) {
	for _, a := range []string{
		"detachTab",                                   // detach
		"restoreTool",                                 // detach --restore
		"renameTab",                                   // dmctl rename-tab
		"renameWindow",                                // dmctl rename-window
		"paneUp", "paneDown", "paneLeft", "paneRight", // dmctl tool-{up,down,left,right}
	} {
		if !hub.AllowedCmdActions[a] {
			t.Errorf("CLI 가 보내는 %q 가 hub.AllowedCmdActions 에 없다", a)
		}
	}
}
