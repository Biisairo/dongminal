package telegram

import (
	"strconv"
	"testing"
)

// REFACTOR3_GO_STRUCT_SRS FR-RGS-20 (GD-12): 도구가 사라지면 그 탭의 직전 hook 을 잊는다.
// 이전에는 넣기만 해 도구 N 개를 만들고 지우면 b.tabs 에 N 개가 남았다.
func TestBridgeForgetsGoneTools(t *testing.T) {
	r := newRig(t)
	const n = 10
	for i := 0; i < n; i++ {
		r.act(Event{ToolID: "tool-" + strconv.Itoa(i), Hook: "Notification", Detail: "x"})
	}
	if got := len(r.b.tabs); got != n {
		t.Fatalf("tabs = %d, want %d", got, n)
	}
	for i := 0; i < n; i++ {
		r.b.OnToolGone("tool-" + strconv.Itoa(i))
	}
	for len(r.b.q) > 0 {
		r.b.process(<-r.b.q)
	}
	if got := len(r.b.tabs); got != 0 {
		t.Fatalf("도구 %d 개가 사라진 뒤 tabs = %d, want 0", n, got)
	}
}

// 꺼져 있어도 잊는다 — 켜 있던 동안 쌓인 것이 남지 않는다.
func TestBridgeForgetsGoneToolsWhileDisabled(t *testing.T) {
	r := newRig(t)
	r.act(Event{ToolID: tabA, Hook: "Notification", Detail: "x"})
	_ = r.st.SetEnabled(false)
	r.b.OnToolGone(tabA)
	for len(r.b.q) > 0 {
		r.b.process(<-r.b.q)
	}
	if got := len(r.b.tabs); got != 0 {
		t.Fatalf("tabs = %d, want 0", got)
	}
}
