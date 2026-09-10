package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// 이 파일은 ACCESS_ALLOWLIST_SRS §4 검증표다. 각 테스트가 어느 FR 을 지키는지
// 이름과 주석에 적는다 — 게이트는 최외곽이라 회귀 하나가 전면 차단이 된다.

func newTestAccessStore(t *testing.T) *accessStore {
	t.Helper()
	st := newAccessStore(filepath.Join(t.TempDir(), "access.json"))
	// 실제 DNS·인터페이스를 타지 않는다. 주입하지 않으면 테스트가 이 기계의
	// 네트워크 상태에 따라 결과가 달라진다.
	st.lookupHost = func(string) ([]string, error) { return nil, nil }
	st.interfaceAddrs = func() ([]netip.Addr, error) { return nil, nil }
	return st
}

func mustSetConfig(t *testing.T, st *accessStore, cfg accessConfig) {
	t.Helper()
	if err := st.setConfig(cfg); err != nil {
		t.Fatalf("setConfig: %v", err)
	}
}

func entry(value string) accessEntry {
	return accessEntry{ID: "e-" + value, Value: value, Label: value, Enabled: true}
}

// gateStatus 는 주어진 출발지로 게이트를 통과시켰을 때의 상태코드다.
func gateStatus(st *accessStore, remoteAddr, path string) int {
	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	req := apiTestRequest(http.MethodGet, path, nil)
	req.RemoteAddr = remoteAddr
	rec := httptest.NewRecorder()
	accessGate(st, ok).ServeHTTP(rec, req)
	return rec.Code
}

// FR-ACL-1·3: 저장한 값이 그대로 다시 읽힌다.
func TestAccessStore_SaveReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.json")
	st := newAccessStore(path)
	st.lookupHost = func(string) ([]string, error) { return nil, nil }
	st.interfaceAddrs = func() ([]netip.Addr, error) { return nil, nil }
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{entry("10.0.0.1")}})

	again := newAccessStore(path)
	got := again.config()
	if !got.Enabled {
		t.Fatalf("enabled 가 살아남지 않았다")
	}
	if len(got.Entries) != 1 || got.Entries[0].Value != "10.0.0.1" {
		t.Fatalf("entries=%+v", got.Entries)
	}
}

// FR-ACL-2: 파일이 없거나 깨져 있어도 서버가 잠기지 않는다 — 열린 상태로 선다.
func TestAccessStore_UnreadableFileStartsOpen(t *testing.T) {
	dir := t.TempDir()
	missing := newAccessStore(filepath.Join(dir, "nope.json"))
	if missing.config().Enabled {
		t.Fatalf("없는 파일에서 enabled=true 로 섰다 — 잠금 위험")
	}
	broken := filepath.Join(dir, "broken.json")
	if err := os.WriteFile(broken, []byte("{ this is not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	st := newAccessStore(broken)
	if st.config().Enabled {
		t.Fatalf("깨진 파일에서 enabled=true 로 섰다 — 잠금 위험")
	}
	if len(st.config().Entries) != 0 {
		t.Fatalf("깨진 파일에서 항목이 생겼다")
	}
}

// FR-ACL-5: 자기 주소는 목록·토글과 무관하게 통과한다. loopback 만이 아니라
// 서버 머신의 인터페이스 주소 전부다 — 자기 이름(`macmini-office`)으로 붙으면
// 출발지가 loopback 이 아니기 때문이다.
func TestAccessGate_SelfAddressAlwaysAllowed(t *testing.T) {
	st := newTestAccessStore(t)
	st.interfaceAddrs = func() ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("100.89.214.106")}, nil
	}
	st.refresh()
	mustSetConfig(t, st, accessConfig{Enabled: true}) // 목록은 비어 있다

	for _, addr := range []string{"127.0.0.1:5000", "[::1]:5000", "100.89.214.106:5000"} {
		if got := gateStatus(st, addr, "/"); got != 200 {
			t.Errorf("%s -> %d, want 200 (자기 주소는 항상 통과)", addr, got)
		}
	}
	// 남의 주소는 여전히 막힌다.
	if got := gateStatus(st, "100.117.248.111:5000", "/"); got != http.StatusForbidden {
		t.Errorf("타 노드 -> %d, want 403", got)
	}
}

// FR-ACL-5a: 인터페이스 수집이 실패해도 loopback 탈출구는 남는다.
func TestAccessGate_LoopbackSurvivesInterfaceFailure(t *testing.T) {
	st := newTestAccessStore(t)
	st.interfaceAddrs = func() ([]netip.Addr, error) { return nil, os.ErrPermission }
	st.refresh()
	mustSetConfig(t, st, accessConfig{Enabled: true})

	if got := gateStatus(st, "127.0.0.1:5000", "/"); got != 200 {
		t.Fatalf("loopback -> %d, want 200 — 최후의 탈출구가 사라졌다", got)
	}
}

// FR-ACL-6: 프록시 헤더는 신뢰하지 않는다. 믿으면 목록이 헤더 한 줄로 무력화된다.
func TestAccessGate_IgnoresForwardedHeaders(t *testing.T) {
	st := newTestAccessStore(t)
	st.refresh()
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{entry("10.0.0.1")}})

	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	req := apiTestRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.9:5000"
	req.Header.Set("X-Forwarded-For", "10.0.0.1")
	req.Header.Set("X-Real-IP", "10.0.0.1")
	rec := httptest.NewRecorder()
	accessGate(st, ok).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d want 403 — 위조 헤더가 게이트를 통과했다", rec.Code)
	}
}

// FR-ACL-7: 토글이 꺼져 있으면 전부 통과한다 (현행 동작).
func TestAccessGate_DisabledPassesEverything(t *testing.T) {
	st := newTestAccessStore(t)
	st.refresh()
	mustSetConfig(t, st, accessConfig{Enabled: false})

	if got := gateStatus(st, "203.0.113.9:5000", "/"); got != 200 {
		t.Fatalf("토글 off 에서 %d — 기존 동작이 깨졌다", got)
	}
}

// FR-ACL-8·9: 켜져 있고 목록에 없으면 403 이며, 응답이 목록을 누설하지 않는다.
func TestAccessGate_BlocksUnlistedWithoutLeaking(t *testing.T) {
	st := newTestAccessStore(t)
	st.refresh()
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{entry("10.0.0.1")}})

	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) })
	req := apiTestRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.9:5000"
	rec := httptest.NewRecorder()
	accessGate(st, ok).ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status=%d want 403", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "10.0.0.1") {
		t.Fatalf("응답이 목록 내용을 누설한다: %q", rec.Body.String())
	}
}

// FR-ACL-11: 정적 자산·/api/*·/ws 를 가리지 않는다. 예외 경로가 생기면 여기서 걸린다.
func TestAccessGate_CoversEverySurface(t *testing.T) {
	st := newTestAccessStore(t)
	st.refresh()
	mustSetConfig(t, st, accessConfig{Enabled: true})

	for _, p := range []string{"/", "/index.html", "/api/state", "/api/settings", "/ws"} {
		if got := gateStatus(st, "203.0.113.9:5000", p); got != http.StatusForbidden {
			t.Errorf("%s -> %d, want 403 — 이 표면이 게이트를 벗어났다", p, got)
		}
	}
}

// FR-ACL-14: IP 리터럴·CIDR·호스트명 각각의 매칭 경계.
func TestAccessMatch_LiteralCIDRHostname(t *testing.T) {
	st := newTestAccessStore(t)
	st.lookupHost = func(h string) ([]string, error) {
		if h == "macmini" {
			return []string{"100.117.248.111"}, nil
		}
		return nil, os.ErrNotExist
	}
	st.refresh()
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{
		entry("10.0.0.1"), entry("192.168.7.0/24"), entry("macmini"),
	}})

	cases := []struct {
		addr string
		want int
	}{
		{"10.0.0.1:5000", 200},        // 리터럴 일치
		{"10.0.0.2:5000", 403},        // 리터럴 불일치
		{"192.168.7.55:5000", 200},    // CIDR 포함
		{"192.168.8.55:5000", 403},    // CIDR 경계 밖
		{"100.117.248.111:5000", 200}, // 호스트명 해석 결과
		{"100.117.248.112:5000", 403}, // 해석 결과 아님
	}
	for _, c := range cases {
		if got := gateStatus(st, c.addr, "/"); got != c.want {
			t.Errorf("%s -> %d, want %d", c.addr, got, c.want)
		}
	}
}

// FR-ACL-15: 요청 경로에서 DNS 를 타지 않는다. 타면 모든 요청에 DNS 왕복이 붙는다.
func TestAccessGate_NoDNSOnRequestPath(t *testing.T) {
	st := newTestAccessStore(t)
	var calls atomic.Int64
	st.lookupHost = func(h string) ([]string, error) {
		calls.Add(1)
		return []string{"100.117.248.111"}, nil
	}
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{entry("macmini")}})
	st.refresh()

	before := calls.Load()
	for i := 0; i < 5; i++ {
		gateStatus(st, "100.117.248.111:5000", "/")
	}
	if got := calls.Load(); got != before {
		t.Fatalf("요청 경로에서 DNS 를 %d 회 탔다 — 캐시만 읽어야 한다", got-before)
	}
}

// FR-ACL-16: 해석에 실패한 호스트명은 아무도 통과시키지 않고, 그 사실이 드러난다.
func TestAccessEntry_ResolveFailureBlocksAndSurfaces(t *testing.T) {
	st := newTestAccessStore(t)
	st.lookupHost = func(string) ([]string, error) { return nil, os.ErrNotExist }
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{entry("macmini.local")}})
	st.refresh()

	if got := gateStatus(st, "100.117.248.111:5000", "/"); got != http.StatusForbidden {
		t.Fatalf("해석 실패 항목이 통과시켰다: %d", got)
	}
	view := st.view()
	if len(view.Entries) != 1 || view.Entries[0].Error == "" {
		t.Fatalf("해석 실패가 view 에 드러나지 않는다: %+v", view.Entries)
	}
}

// FR-ACL-17: 꺼 둔 항목은 판정에서 빠진다 — 지우지 않고 잠시 끌 수 있어야 한다.
func TestAccessEntry_DisabledEntryIsIgnored(t *testing.T) {
	st := newTestAccessStore(t)
	off := entry("10.0.0.1")
	off.Enabled = false
	mustSetConfig(t, st, accessConfig{Enabled: true, Entries: []accessEntry{off}})
	st.refresh()

	if got := gateStatus(st, "10.0.0.1:5000", "/"); got != http.StatusForbidden {
		t.Fatalf("꺼 둔 항목이 통과시켰다: %d", got)
	}
}

// FR-ACL-18: 형식이 유효하지 않은 값은 저장 시점에 거절한다. 저장된 뒤 조용히
// 무시되면 사용자는 규칙이 걸린 줄 안다.
func TestAccessStore_RejectsInvalidValue(t *testing.T) {
	st := newTestAccessStore(t)
	for _, bad := range []string{"", "   ", "10.0.0.300", "192.168.0.0/99", "has space", "http://macmini"} {
		if err := st.setConfig(accessConfig{Enabled: true, Entries: []accessEntry{entry(bad)}}); err == nil {
			t.Errorf("%q 가 저장을 통과했다", bad)
		}
	}
	if len(st.config().Entries) != 0 {
		t.Fatalf("거절된 저장이 상태를 오염시켰다: %+v", st.config().Entries)
	}
}

// FR-ACL-19·20: 종단 왕복과 저장 후 방송.
func TestAccessAPI_RoundTripAndBroadcast(t *testing.T) {
	broker := &fakeCommandBroker{}
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{Commands: broker})
	if err != nil {
		t.Fatal(err)
	}
	body := `{"enabled":true,"entries":[{"id":"a","value":"10.0.0.1","label":"nas","enabled":true}]}`
	req := apiTestRequest(http.MethodPut, "/api/access", strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:5000"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("PUT status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = apiTestRequest(http.MethodGet, "/api/access", nil)
	req.RemoteAddr = "127.0.0.1:5000"
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("GET status=%d", rec.Code)
	}
	var got accessView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("GET body=%s err=%v", rec.Body.String(), err)
	}
	if !got.Enabled || len(got.Entries) != 1 || got.Entries[0].Value != "10.0.0.1" {
		t.Fatalf("왕복이 값을 잃었다: %+v", got)
	}
	if len(broker.published) != 1 {
		t.Fatalf("방송 %d 회 — 저장 뒤 정확히 1회여야 한다", len(broker.published))
	}
}

// FR-ACL-18(종단): 유효하지 않은 값은 400 이며 저장되지 않는다.
func TestAccessAPI_InvalidValueIs400(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	req := apiTestRequest(http.MethodPut, "/api/access",
		strings.NewReader(`{"enabled":true,"entries":[{"id":"a","value":"nope!!","enabled":true}]}`))
	req.RemoteAddr = "127.0.0.1:5000"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d want 400", rec.Code)
	}
	if len(srv.Access.config().Entries) != 0 {
		t.Fatalf("거절된 PUT 이 저장됐다")
	}
}

// FR-ACL-23: 설정 화면이 "지금 내 출발지" 를 보여줄 수 있어야 한다 — 무엇을
// 목록에 넣어야 하는지 사용자가 알 방법이 달리 없다.
func TestAccessAPI_ReportsCallerAddress(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	req := apiTestRequest(http.MethodGet, "/api/access", nil)
	req.RemoteAddr = "100.117.248.111:5000"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	var got accessView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.You != "100.117.248.111" {
		t.Fatalf("you=%q want 100.117.248.111", got.You)
	}
}
