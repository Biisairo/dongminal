package hub

import "testing"

// V-M11-23·24 (M11_SRS FR-M11-10 / M11-B9): **시선을 옮기는 명령은 한 곳에서만 돈다.**
//
// 지명이 없는 명령은 `event-bus.js` 의 게이트를 그냥 지나가므로 **붙어 있는 브라우저
// 전부**가 수행한다. 실측에서 `window-next` 하나가 두 브라우저를 함께 옮겼고,
// `close-window` 는 그 창을 보지도 않던 쪽까지 끌고 갔다 (SRS §2.7).
//
// 종전 주석은 나머지를 *"idempotent across clients"* 로 적었다. 트리는 그렇지만
// **시선은 그렇지 않다** — 이 표가 그 구분이다.

// viewMoving 은 화면을 옮기거나 워크스페이스를 줄이는 명령이다. 전부 지명되어야 한다.
var viewMoving = []string{
	"focus", "closeTab", "closeWindow", "detachTab",
	"windowNext", "windowPrev", "tabNext", "tabPrev",
	"paneUp", "paneDown", "paneLeft", "paneRight",
}

// entityCreating 은 종전부터 지명되던 것들이다 — 이 조항이 되돌리지 않는다.
var entityCreating = []string{
	"newWindow", "newTab", "splitH", "splitV", "openEditorTab", "restoreTool", "openUrl",
}

func TestSingleExecutor_CoversViewMovingActions(t *testing.T) {
	for _, a := range viewMoving {
		if !AllowedCmdActions[a] {
			t.Fatalf("%q 가 허용 목록에 없다 — 표가 어긋났다", a)
		}
		if !IsSingleExecutorAction(a) {
			t.Errorf("%q 가 지명되지 않는다 — 붙어 있는 브라우저 전부가 화면을 옮긴다 (M11-B9)", a)
		}
	}
}

func TestSingleExecutor_KeepsEntityCreatingActions(t *testing.T) {
	for _, a := range entityCreating {
		if !IsSingleExecutorAction(a) {
			t.Errorf("%q 의 종전 지명이 사라졌다 (FR-SXE-1)", a)
		}
	}
}

// 순수 데이터 변경은 **지명하지 않는다.** 시선을 건드리지 않고 클라이언트마다 같은
// 결과로 수렴하므로, 한 곳으로 좁히면 그 클라이언트가 없을 때 이름이 영영 안 바뀐다.
func TestSingleExecutor_LeavesPureDataUngated(t *testing.T) {
	for _, a := range []string{"renameTab", "renameWindow"} {
		if IsSingleExecutorAction(a) {
			t.Errorf("%q 는 시선을 옮기지 않는다 — 좁힐 이유가 없다", a)
		}
	}
}

// 허용 목록과 지명 목록이 **함께** 움직이는지 본다. 새 명령을 더하면서 이 판정을
// 빠뜨리면 그 명령이 조용히 모든 브라우저에서 돈다 — 그것이 M11-B9 가 생긴 길이다.
func TestSingleExecutor_EveryAllowedActionIsClassified(t *testing.T) {
	known := map[string]bool{}
	for _, a := range viewMoving {
		known[a] = true
	}
	for _, a := range entityCreating {
		known[a] = true
	}
	known["renameTab"], known["renameWindow"] = true, true

	for a := range AllowedCmdActions {
		if !known[a] {
			t.Errorf("%q 가 어느 갈래에도 없다 — 지명할지 정하지 않은 명령이다", a)
		}
	}
}
