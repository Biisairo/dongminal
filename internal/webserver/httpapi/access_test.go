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

// ── 묶음 H — 이 컴퓨터의 별명 (축②, U-18) ─────────────────────────
//
// 재는 것은 축①과 다르다. 축①은 "누가 들어오나"(출발지 IP)이고 여기는 "뭐라고
// 불리며 들어오나"(Host 이름)다. 두 축이 섞이면 사용자는 자기 서버에 이름으로
// 붙지 못하면서 그 이유를 알 방법이 없다 — 그것이 U-18 이었다.

// FR-ACL-25·27: 별명 목록이 저장되고 그대로 다시 읽힌다.
func TestHostAlias_SaveReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.json")
	st := newAccessStore(path)
	st.lookupHost = func(string) ([]string, error) { return nil, nil }
	st.interfaceAddrs = func() ([]netip.Addr, error) { return nil, nil }
	mustSetConfig(t, st, accessConfig{
		Entries: []accessEntry{entry("10.0.0.1")},
		Hosts:   []accessEntry{entry("macmini-office")},
	})

	again := newAccessStore(path)
	got := again.config()
	if len(got.Hosts) != 1 || got.Hosts[0].Value != "macmini-office" {
		t.Fatalf("hosts=%+v — 별명이 살아남지 않았다", got.Hosts)
	}
	if len(got.Entries) != 1 {
		t.Fatalf("entries=%+v — 축①이 함께 상했다", got.Entries)
	}
}

// FR-ACL-27: `hosts` 키가 없는 **기존 파일**은 빈 목록으로 읽힌다. 하위 호환이
// 깨지면 업그레이드 순간 접속 판정이 바뀐다.
func TestHostAlias_MissingKeyIsEmpty(t *testing.T) {
	path := filepath.Join(t.TempDir(), "access.json")
	old := `{"enabled":true,"entries":[{"id":"a","value":"10.0.0.1","enabled":true}]}`
	if err := os.WriteFile(path, []byte(old), 0o644); err != nil {
		t.Fatal(err)
	}
	st := newAccessStore(path)
	cfg := st.config()
	if len(cfg.Hosts) != 0 {
		t.Fatalf("hosts=%+v want 빈 목록", cfg.Hosts)
	}
	if !cfg.Enabled || len(cfg.Entries) != 1 {
		t.Fatalf("기존 필드를 잃었다: %+v", cfg)
	}
}

// FR-ACL-28: 짧은 이름·FQDN·`.local` 을 받는다.
//
// `.local` 이 여기서 유효한 이유는 축②가 **문자열 비교**라 DNS 해석이 필요 없기
// 때문이다. FR-ACL-14a(mDNS 미지원)는 해석이 필요한 축①의 조항이다.
func TestHostAlias_AcceptsHostnames(t *testing.T) {
	st := newTestAccessStore(t)
	for _, ok := range []string{"macmini-office", "macmini-office.tail5da9ae.ts.net", "macmini.local"} {
		if err := st.setConfig(accessConfig{Hosts: []accessEntry{entry(ok)}}); err != nil {
			t.Errorf("%q 가 거절됐다: %v", ok, err)
		}
	}
}

// FR-ACL-29: **와일드카드를 지원하지 않는다.** 축②는 DNS 리바인딩 방어의
// 화이트리스트이므로, 넓힐 수 있는 문법을 UI 에 놓지 않는다.
//
// 이 목록이 이 변경의 보안 경계다 — 하나라도 통과하면 사용자가 "아무 도메인이나
// 통과시키는 값" 을 저장할 수 있다.
func TestHostAlias_RejectsWildcardsAndNonNames(t *testing.T) {
	st := newTestAccessStore(t)
	bad := []string{
		"", "   ", // 빈 값
		"*", "*.", "*.ts.net", "*.local", "a*b", "?", "**", // 와일드카드 7형태
		"100.89.214.106", "::1", "192.168.0.0/24", // IP·CIDR
		"http://macmini-office", "macmini-office:58146", "macmini-office/x", "u@macmini-office", // 스킴·포트·경로·사용자
		"-x", "x-", "x..y", strings.Repeat("a", 254), // 라벨 규칙·길이
	}
	for _, v := range bad {
		if err := st.setConfig(accessConfig{Hosts: []accessEntry{entry(v)}}); err == nil {
			t.Errorf("%q 가 저장을 통과했다 — 보안 경계가 넓어졌다", v)
		}
	}
	if len(st.config().Hosts) != 0 {
		t.Fatalf("거절된 저장이 상태를 오염시켰다: %+v", st.config().Hosts)
	}
}

// FR-ACL-30: 앞뒤 공백·대소문자·후행 점을 정규화해 저장한다. 정규화하지 않으면
// 같은 이름이 두 벌로 저장되고 한쪽만 판정에 걸린다.
func TestHostAlias_NormalizedOnSave(t *testing.T) {
	st := newTestAccessStore(t)
	mustSetConfig(t, st, accessConfig{Hosts: []accessEntry{entry("  MacMini-Office.  ")}})
	got := st.config().Hosts
	if len(got) != 1 || got[0].Value != "macmini-office" {
		t.Fatalf("hosts=%+v want value=macmini-office", got)
	}
}

// FR-ACL-30: 하나라도 유효하지 않으면 **아무것도 저장하지 않는다** (FR-ACL-18 승계).
// 부분 저장은 사용자가 건 규칙과 실제 규칙을 어긋나게 만든다.
func TestHostAlias_AllOrNothing(t *testing.T) {
	st := newTestAccessStore(t)
	mustSetConfig(t, st, accessConfig{Hosts: []accessEntry{entry("macmini-office")}})
	err := st.setConfig(accessConfig{Hosts: []accessEntry{entry("macbook-air"), entry("*.ts.net")}})
	if err == nil {
		t.Fatal("무효한 줄이 섞인 저장이 통과했다")
	}
	got := st.config().Hosts
	if len(got) != 1 || got[0].Value != "macmini-office" {
		t.Fatalf("hosts=%+v — 거절된 저장이 앞 줄을 남겼거나 이전 값을 지웠다", got)
	}
}

// FR-ACL-34: 별명은 **해석하지 않는다.** 이름↔이름 비교이므로 해석할 것이 없고,
// 해석하면 UI 에 "해석 실패" 라는 무관한 오류가 뜬다.
func TestHostAlias_NeverResolved(t *testing.T) {
	st := newTestAccessStore(t)
	var calls atomic.Int64
	st.lookupHost = func(string) ([]string, error) {
		calls.Add(1)
		return []string{"100.89.214.106"}, nil
	}
	mustSetConfig(t, st, accessConfig{Hosts: []accessEntry{entry("macmini-office")}})
	st.refresh()

	if got := calls.Load(); got != 0 {
		t.Fatalf("별명 때문에 DNS 를 %d 회 탔다 — 해석 대상이 아니다", got)
	}
	v := st.view()
	if len(v.Hosts) != 1 || v.Hosts[0].Value != "macmini-office" {
		t.Fatalf("view.hosts=%+v", v.Hosts)
	}
}

// FR-ACL-35: 응답은 **가산적**이다. 기존 필드가 그대로 있고, 별명 편집에 필요한
// 셋이 더해진다 — 무엇을 넣어야 하는지 알 방법이 이것뿐이다(FR-ACL-23 과 같은 근거).
func TestAccessAPI_HostAliasView(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	srv.Access.lookupHost = func(string) ([]string, error) { return nil, nil }
	body := `{"enabled":false,"entries":[{"id":"a","value":"10.0.0.1","enabled":true}],` +
		`"hosts":[{"id":"h","value":"macmini-office","label":"tailnet","enabled":true}]}`
	req := apiTestRequest(http.MethodPut, "/api/access", strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:5000"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("PUT status=%d body=%s", rec.Code, rec.Body.String())
	}

	req = apiTestRequest(http.MethodGet, "/api/access", nil)
	req.RemoteAddr = "127.0.0.1:5000"
	req.Host = "macmini-office:58146"
	rec = httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("GET status=%d body=%s", rec.Code, rec.Body.String())
	}
	var got accessView
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Hosts) != 1 || got.Hosts[0].Value != "macmini-office" {
		t.Fatalf("hosts=%+v", got.Hosts)
	}
	if got.Hostname == "" {
		t.Fatal("hostname 이 비었다 — 서버가 자기를 무엇으로 아는지가 U-18 의 원인이었다")
	}
	if got.Host != "macmini-office" {
		t.Fatalf("host=%q want macmini-office (지금 들어온 이름)", got.Host)
	}
	if len(got.Entries) != 1 || got.You == "" {
		t.Fatalf("기존 필드가 상했다: %+v", got)
	}
}

// FR-ACL-36: `PUT` 은 종전대로 **전체 교체**다. `hosts` 없는 본문은 별명 목록을
// 빈 목록으로 바꾼다 — 어느 필드가 병합되고 어느 것이 교체되는지가 문서 밖에
// 남으면 다음 필드에서 같은 질문을 다시 한다.
func TestAccessAPI_HostsOmittedReplacesWithEmpty(t *testing.T) {
	srv, err := New(Config{DataDir: t.TempDir()}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	srv.Access.lookupHost = func(string) ([]string, error) { return nil, nil }
	mustSetConfig(t, srv.Access, accessConfig{Hosts: []accessEntry{entry("macmini-office")}})

	req := apiTestRequest(http.MethodPut, "/api/access", strings.NewReader(`{"enabled":false,"entries":[]}`))
	req.RemoteAddr = "127.0.0.1:5000"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != 200 {
		t.Fatalf("PUT status=%d body=%s", rec.Code, rec.Body.String())
	}
	if got := srv.Access.config().Hosts; len(got) != 0 {
		t.Fatalf("hosts=%+v want 빈 목록 (전체 교체)", got)
	}
}
