package httpapi

import (
	"fmt"
	"net/netip"
	"testing"
	"time"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-8-2 (HTTP-4) — 요청 경로의 판정은 설정이 바뀔 때만
// 만든 스냅샷을 읽는다. 전역 뮤텍스를 잡지 않고, 항목을 요청마다 다시 파싱하지 않는다.

// 판정은 저장소 락을 잡지 않는다 — 락을 쥔 채로도 답한다.
func TestAccessMatcher_NoStoreLockOnRequestPath(t *testing.T) {
	st := newTestAccessStore(t)
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{entry("10.0.0.0/8")},
		Hosts: []accessEntry{entry("box.example")}})
	st.mu.Lock()
	defer st.mu.Unlock()
	done := make(chan [3]bool, 1)
	go func() {
		done <- [3]bool{
			st.allowed(netip.MustParseAddr("10.1.2.3")),
			st.isSelf(netip.MustParseAddr("127.0.0.1")),
			st.hasHostAlias("box.example"),
		}
	}()
	select {
	case got := <-done:
		if got != [3]bool{true, true, true} {
			t.Fatalf("판정 = %v", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("요청 경로 판정이 저장소 락을 기다린다")
	}
}

// 무효화 조건 ① 설정 변경: 저장 직후의 요청이 새 목록으로 판정된다.
func TestAccessMatcher_RebuiltOnSetConfig(t *testing.T) {
	st := newTestAccessStore(t)
	a := netip.MustParseAddr("192.168.1.9")
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{entry("10.0.0.1")}})
	if st.allowed(a) {
		t.Fatal("목록에 없는 출발지를 들였다")
	}
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{entry("192.168.1.0/24")}})
	if !st.allowed(a) {
		t.Fatal("설정 변경 뒤에도 옛 스냅샷으로 판정한다")
	}
	off := entry("192.168.1.0/24")
	off.Enabled = false
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{off}})
	if st.allowed(a) {
		t.Fatal("꺼진 항목이 스냅샷에 남았다 (FR-ACL-17)")
	}
	mustSetConfig(t, st, accessConfig{Enabled: false})
	if !st.allowed(a) {
		t.Fatal("목록을 끈 뒤에도 막는다 (FR-ACL-7)")
	}
	mustSetConfig(t, st, accessConfig{Hosts: []accessEntry{entry("Box.Example")}})
	if !st.hasHostAlias("box.example") || !st.hasHostAlias("BOX.EXAMPLE") {
		t.Fatal("축② 변경이 스냅샷에 반영되지 않았다")
	}
}

// 무효화 조건 ② 주기 갱신: 인터페이스·호스트명 해석이 바뀌면 스냅샷도 바뀐다.
func TestAccessMatcher_RebuiltOnRefresh(t *testing.T) {
	st := newTestAccessStore(t)
	peer := netip.MustParseAddr("100.64.0.7")
	self := netip.MustParseAddr("100.64.0.1")
	var resolveTo []string
	st.lookupHost = func(string) ([]string, error) { return resolveTo, nil }
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{entry("peer.example")}})
	if st.allowed(peer) || st.isSelf(self) {
		t.Fatal("해석 전인데 통과했다")
	}
	resolveTo = []string{peer.String()}
	st.interfaceAddrs = func() ([]netip.Addr, error) { return []netip.Addr{self}, nil }
	st.refresh()
	if !st.allowed(peer) {
		t.Fatal("해석 결과가 스냅샷에 반영되지 않았다")
	}
	if !st.isSelf(self) || !st.allowed(self) {
		t.Fatal("인터페이스 주소가 스냅샷에 반영되지 않았다")
	}
}

// 무효화 조건 ③ 저장 실패: 되돌린 설정으로 스냅샷도 되돌아간다 (FR-SAF-2).
func TestAccessMatcher_RestoredOnSaveFailure(t *testing.T) {
	st := newAccessStoreAt(t, unwritablePath(t))
	a := netip.MustParseAddr("192.168.1.9")
	if err := st.setConfig(accessConfig{Enabled: true, Entries: []accessEntry{entry("10.0.0.1")}}); err == nil {
		t.Fatal("저장이 성공했다")
	}
	if !st.allowed(a) {
		t.Fatal("저장에 실패한 목록이 스냅샷에 남았다")
	}
}

// 항목 64개에서 판정 하나의 비용 (FR-OPT-0-4 계수).
func BenchmarkAccessAllowed(b *testing.B) {
	st := newAccessStore(b.TempDir() + "/access.json")
	st.lookupHost = func(string) ([]string, error) { return nil, nil }
	st.interfaceAddrs = func() ([]netip.Addr, error) { return nil, nil }
	var es []accessEntry
	for i := 0; i < 64; i++ {
		es = append(es, entry(fmt.Sprintf("10.%d.0.0/16", i)))
	}
	if err := st.setConfig(accessConfig{Enabled: true, Entries: es}); err != nil {
		b.Fatal(err)
	}
	a := netip.MustParseAddr("192.168.1.9")
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		st.allowed(a)
	}
}
