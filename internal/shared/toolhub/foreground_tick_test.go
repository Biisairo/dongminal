package toolhub

import (
	"testing"
	"time"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-2-1 — 데몬 모드의 전경 조회는 데몬의 티커가 돌리고,
// list 응답은 캐시만 읽는다. dispatch 경로에서 탐침(ps)이 빠진다.

// ListCached 는 탐침을 부르지 않는다. 값은 마지막 갱신의 캐시다.
func TestListCachedDoesNotProbe(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	adoptDetached(pm, "a")
	calls := fakeFGProbe(t, func([]fgRequest) map[string]string {
		return map[string]string{"a": "vim"}
	})

	for _, m := range pm.ListCached() {
		if m.FgName != "" {
			t.Fatalf("갱신 전인데 fgName=%q", m.FgName)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("ListCached 가 탐침을 %d회 불렀다 — 0 이어야 한다", len(*calls))
	}
	pm.RefreshForeground()
	for i := 0; i < 5; i++ {
		got := pm.ListCached()
		if len(got) != 1 || got[0].FgName != "vim" {
			t.Fatalf("캐시가 목록에 실리지 않았다: %+v", got)
		}
	}
	if len(*calls) != 1 {
		t.Fatalf("탐침 %d회 — 갱신 1회만이어야 한다", len(*calls))
	}
}

// StartForegroundRefresh 는 틱마다 갱신하고, 바뀐 값을 notifier 로 민다.
func TestStartForegroundRefreshTicks(t *testing.T) {
	pm := NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	adoptDetached(pm, "a")
	calls := fakeFGProbe(t, func([]fgRequest) map[string]string {
		return map[string]string{"a": "vim"}
	})
	got := make(chan string, 4)
	pm.SetForegroundNotifier(func(_, name string) { got <- name })

	stop := make(chan struct{})
	tick := make(chan time.Time)
	pm.StartForegroundRefresh(stop, tick)
	tick <- time.Now()
	select {
	case name := <-got:
		if name != "vim" {
			t.Fatalf("notify=%q want vim", name)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("틱이 왔는데 갱신·알림이 없다")
	}
	close(stop)
	if len(*calls) != 1 {
		t.Fatalf("탐침 %d회 want 1", len(*calls))
	}
}
