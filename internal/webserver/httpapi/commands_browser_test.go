package httpapi

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"dongminal/internal/webserver/hub"
)

// 브라우저의 원격 action 처리기 표(REMOTE_ACTIONS)와 서버 화이트리스트는 같은 집합이어야
// 한다. 표에 있는데 허용 표에 없으면 POST /api/commands 가 400 으로 거부해 브라우저 코드에
// 도달하지 못하고, 허용 표에 있는데 처리기가 없으면 받은 명령이 공통 경로로 떨어진다.
//
// P6 의 detach CLI 가 앞의 상태로 배선됐다. detach_test.go 는 httptest 스텁
// 서버에 POST 하므로 어떤 action 이든 통과해 결함이 드러나지 않았다.
// 생산자(브라우저)와 검증자(서버)를 직접 대조해 재발을 막는다.
//
// OPTIMIZE_REFACTOR_SRS FR-OPT-11-2: _execRemote 의 if-체인이 표가 되어 대조가 양방향이 됐다
// (web/js/test/remote-actions.test.mjs 가 같은 대조를 브라우저 쪽에서 한다).
func TestAllowedCmdActions_CoversBrowserHandled(t *testing.T) {
	src, err := os.ReadFile("../../../web/js/core/app-cmd.js")
	if err != nil {
		t.Fatalf("app-cmd.js 읽기 실패: %v", err)
	}
	body := remoteActionsBody(t, string(src))

	re := regexp.MustCompile(`(?m)^\s*([A-Za-z]+):\(app,a\)=>`)
	seen := map[string]bool{}
	for _, m := range re.FindAllStringSubmatch(body, -1) {
		seen[m[1]] = true
	}
	if len(seen) < 5 {
		t.Fatalf("REMOTE_ACTIONS 에서 추출한 action 이 %d 개뿐 — 파싱이 깨졌다", len(seen))
	}
	for a := range seen {
		if !hub.IsAllowedCmdAction(a) {
			t.Errorf("브라우저는 %q 를 처리하지만 hub 허용 표(cmdActions)에 없다 — /api/commands 가 400 으로 거부한다", a)
		}
	}
	for _, a := range hub.AllowedCmdActionNames() {
		if !seen[a] {
			t.Errorf("hub 허용 표의 %q 에 브라우저 처리기(REMOTE_ACTIONS)가 없다", a)
		}
	}
}

// remoteActionsBody 는 app-cmd.js 에서 REMOTE_ACTIONS 표 본문만 잘라낸다.
func remoteActionsBody(t *testing.T, src string) string {
	t.Helper()
	start := strings.Index(src, "const REMOTE_ACTIONS=Object.freeze({")
	if start < 0 {
		t.Fatal("app-cmd.js 에서 REMOTE_ACTIONS 를 찾지 못했다 — 테스트를 갱신하라")
	}
	end := strings.Index(src[start:], "\n});")
	if end < 0 {
		t.Fatal("app-cmd.js 에서 REMOTE_ACTIONS 의 끝 경계를 찾지 못했다 — 테스트를 갱신하라")
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
		if !hub.IsAllowedCmdAction(a) {
			t.Errorf("CLI 가 보내는 %q 가 hub 허용 표(cmdActions)에 없다", a)
		}
	}
}
