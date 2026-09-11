package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"

	"dongminal/internal/webserver/httpreq"
	"net/netip"
	"os"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/platform"
)

// 접속 허용 목록과 그 게이트 (ACCESS_ALLOWLIST_SRS).
//
// `--expose` 는 0.0.0.0 에 바인드하는 것이 전부였고 그 뒤에 아무 제어가 없었다.
// 이 서버가 여는 표면은 PTY·파일·명령 실행이므로 그 상태는 인증 없는 원격 코드
// 실행 종단과 같다. 여기가 그 문을 지키는 유일한 자리다.
//
// **저장소가 `settings.json` 이 아닌 이유.** 그 blob 은 "서버가 해석하지 않는다"
// 가 규약이다 (handlers_settings.go 머리). 접근 제어는 서버가 해석해야 하는
// 값이므로 파일을 나눈다.

// DefaultAccessRefresh 는 호스트명 해석과 인터페이스 수집의 주기다. 요청 경로는
// 이 결과만 읽는다 (FR-ACL-15).
const DefaultAccessRefresh = 60 * time.Second

// accessEntry 는 허용 목록의 한 줄이다. 이것이 디스크에 저장되는 모양이다.
type accessEntry struct {
	ID      string `json:"id"`
	Value   string `json:"value"`
	Label   string `json:"label"`
	Enabled bool   `json:"enabled"`
}

// accessConfig 는 access.json 전체다.
type accessConfig struct {
	Enabled bool          `json:"enabled"`
	Entries []accessEntry `json:"entries"`
	// Hosts 는 축② — 이 서버가 **불리는 이름**들이다 (FR-ACL-25). 축①(`Entries`)과
	// 나누는 이유는 묻는 것이 다르기 때문이다: 저기는 "누가 들어오나", 여기는
	// "뭐라고 불리며 들어오나". 섞으면 사용자가 축②에 무엇을 적어야 하는지 알
	// 방법이 없어진다 (U-18).
	Hosts []accessEntry `json:"hosts,omitempty"`
}

// accessEntryView 는 항목에 **해석 결과**를 얹은 응답 모양이다. 저장 모양과
// 나누는 이유는 해석 상태가 파생값이기 때문이다 — 저장하면 두 진실이 생긴다.
type accessEntryView struct {
	accessEntry
	Resolved []string `json:"resolved,omitempty"`
	Error    string   `json:"error,omitempty"`
}

// accessView 는 GET /api/access 의 응답이다.
//
// `You` 가 있는 이유는 FR-ACL-23 이다 — 무엇을 목록에 넣어야 하는지 사용자가
// 알 방법이 달리 없다. 같은 기기라도 tailscale 로 왔는지 LAN 으로 왔는지에 따라
// 출발지가 다르다.
type accessView struct {
	Enabled bool              `json:"enabled"`
	Entries []accessEntryView `json:"entries"`
	You     string            `json:"you"`
	Self    []string          `json:"self,omitempty"`
	// FR-ACL-35: 축②의 편집에 필요한 셋. `Hosts` 에 해석 상태가 없는 이유는
	// 별명을 해석하지 않기 때문이다 (FR-ACL-34).
	Hosts []accessEntry `json:"hosts"`
	// Hostname 은 서버가 자기를 무엇으로 아는가다 — U-18 의 원인이 이 값이었고
	// 사용자가 그것을 알 방법이 없었다. Host 는 **지금 이 요청의 이름**이다
	// (`You` 와 같은 근거, FR-ACL-23).
	Hostname string `json:"hostname,omitempty"`
	Host     string `json:"host,omitempty"`
}

type accessStore struct {
	mu       sync.Mutex
	path     string
	cfg      accessConfig
	resolved map[string][]netip.Addr // 호스트명 → 해석된 주소
	resErr   map[string]string       // 호스트명 → 해석 실패 사유
	self     []netip.Addr            // 이 머신의 인터페이스 주소 (FR-ACL-5)

	// 주입 지점. 테스트가 이 기계의 DNS·인터페이스 상태에 좌우되지 않게 한다.
	lookupHost     func(string) ([]string, error)
	interfaceAddrs func() ([]netip.Addr, error)
}

func newAccessStore(path string) *accessStore {
	s := &accessStore{
		path:           path,
		resolved:       map[string][]netip.Addr{},
		resErr:         map[string]string{},
		lookupHost:     net.LookupHost,
		interfaceAddrs: localInterfaceAddrs,
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("loadAccess: %v", err)
		}
		return s
	}
	var cfg accessConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		// FR-ACL-2: 읽기 실패가 서버를 잠그지 않는다. 열린 상태로 서고 로그만 남긴다.
		log.Printf("loadAccess: %v — 허용 목록을 끈 채로 시작한다", err)
		return s
	}
	s.cfg = cfg
	log.Printf("access loaded: enabled=%v entries=%d hosts=%d", cfg.Enabled, len(cfg.Entries), len(cfg.Hosts))
	return s
}

func (s *accessStore) config() accessConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	return accessConfig{
		Enabled: s.cfg.Enabled,
		Entries: append([]accessEntry(nil), s.cfg.Entries...),
		Hosts:   append([]accessEntry(nil), s.cfg.Hosts...),
	}
}

// errAccessSaveFailed 는 **저장 자체가 실패**했다는 뜻이다. 검증 실패와 갈라 두는
// 이유는 응답의 모양이다 — 검증 실패의 사유는 사용자가 보고 고치는 것이고, 저장
// 실패의 사유는 내부 사정이라 감춘다 (04-secops SEC-17).
var errAccessSaveFailed = errors.New("허용 목록을 저장하지 못했습니다")

// setConfig 는 목록 전체를 교체한다. **하나라도 유효하지 않으면 아무것도
// 저장하지 않는다** (FR-ACL-18) — 부분 저장은 사용자가 건 규칙과 실제 규칙을
// 어긋나게 만든다.
func (s *accessStore) setConfig(cfg accessConfig) error {
	entries := make([]accessEntry, 0, len(cfg.Entries))
	for i, e := range cfg.Entries {
		v := strings.TrimSpace(e.Value)
		if err := validateAccessValue(v); err != nil {
			return fmt.Errorf("entries[%d]: %w", i, err)
		}
		e.Value = v
		e.Label = strings.TrimSpace(e.Label)
		entries = append(entries, e)
	}
	// FR-ACL-30: 축②도 같은 규약이다 — 하나라도 유효하지 않으면 아무것도 저장하지
	// 않는다. 축①보다 좁게 받으므로(FR-ACL-29) 검증 함수를 따로 쓴다.
	hosts := make([]accessEntry, 0, len(cfg.Hosts))
	for i, e := range cfg.Hosts {
		v, err := normalizeHostAlias(e.Value)
		if err != nil {
			return fmt.Errorf("hosts[%d]: %w", i, err)
		}
		e.Value = v
		e.Label = strings.TrimSpace(e.Label)
		hosts = append(hosts, e)
	}
	s.mu.Lock()
	s.cfg = accessConfig{Enabled: cfg.Enabled, Entries: entries, Hosts: hosts}
	data, err := json.MarshalIndent(s.cfg, "", "  ")
	s.mu.Unlock()
	if err != nil {
		// 문자열과 불뿐인 구조체라 실무에서 나지 않는다. 나더라도 사용자에게 할
		// 말은 없으므로 전문은 로그로만 간다 (04-secops SEC-17).
		log.Printf("saveAccess marshal: %v", err)
		return errAccessSaveFailed
	}
	// 원자적으로 쓴다 — 사용자가 손으로 만든 값이고 잘리면 되돌릴 방법이 없다
	// (settings 저장과 같은 근거).
	if err := platform.WriteStateFile(s.path, data, 0o644); err != nil {
		log.Printf("saveAccess: %v", err)
	}
	// 새로 들어온 호스트명이 곧바로 상태를 갖게 한다. 이것이 없으면 저장 직후
	// 화면이 "해석 안 됨" 으로 보인다.
	s.refresh()
	return nil
}

// validateAccessValue 는 IP 리터럴·CIDR·호스트명 셋 중 하나인지 본다 (FR-ACL-14).
func validateAccessValue(v string) error {
	if v == "" {
		return fmt.Errorf("빈 값")
	}
	if _, err := netip.ParseAddr(v); err == nil {
		return nil
	}
	if _, err := netip.ParsePrefix(v); err == nil {
		return nil
	}
	if isHostname(v) {
		return nil
	}
	return fmt.Errorf("%q 는 IP·CIDR·호스트명 중 어느 것도 아니다", v)
}

// normalizeHostAlias 는 축②의 값 하나를 검증하고 정규화한다 (FR-ACL-28·29·30).
//
// **와일드카드를 받지 않는다.** 축②는 DNS 리바인딩 방어의 화이트리스트이므로,
// 넓힐 수 있는 문법을 UI 에 놓지 않는다 — 받으면 "어디까지 넓은 것을 막을지"
// 라는 판정을 새로 만들어야 하고 그 판정이 곧 다음 구멍의 자리가 된다. 정말
// 필요한 배치의 입구는 `--allowed-host`(`hostAllow.extra`) 로 남아 있다.
//
// IP·CIDR·포트·스킴도 거절이다 — 그것들은 축①(`Entries`)의 어휘다. 축①과 달리
// `.local` 은 유효하다: 여기는 문자열 비교라 DNS 해석이 필요 없다 (FR-ACL-34).
func normalizeHostAlias(raw string) (string, error) {
	v := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(raw), "."))
	if v == "" {
		return "", fmt.Errorf("빈 값")
	}
	// 와일드카드를 **먼저** 가른다. `isHostname` 도 이것을 거절하지만, 그때의
	// 사유는 "호스트명이 아니다" 라서 사용자가 왜 안 되는지 알 수 없다.
	if strings.ContainsAny(v, "*?") {
		return "", fmt.Errorf("%q — 와일드카드는 쓸 수 없다. 이 컴퓨터가 불리는 이름을 그대로 적는다", raw)
	}
	if !isHostname(v) {
		return "", fmt.Errorf("%q 는 이름이 아니다 — IP·대역·포트·스킴은 위쪽 허용 목록이 담당한다", raw)
	}
	return v, nil
}

// isHostname 은 RFC 1123 라벨 규칙이다.
//
// **마지막 라벨이 숫자뿐이면 호스트명이 아니다.** 이 한 줄이 `10.0.0.300` 같은
// 오타를 잡는다 — 그것은 IP 파싱에 실패하고, 이 규칙이 없으면 호스트명으로
// 저장돼 영원히 해석되지 않는 항목이 된다.
func isHostname(s string) bool {
	if len(s) > 253 {
		return false
	}
	labels := strings.Split(s, ".")
	for _, label := range labels {
		if label == "" || len(label) > 63 {
			return false
		}
		for i, r := range label {
			switch {
			case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			case r == '-' && i > 0 && i < len(label)-1:
			default:
				return false
			}
		}
	}
	last := labels[len(labels)-1]
	return strings.TrimLeft(last, "0123456789") != ""
}

// refresh 는 호스트명 해석과 인터페이스 수집을 한 번 돈다. 요청 경로 **밖**에서만
// 불린다 (FR-ACL-15).
func (s *accessStore) refresh() {
	s.mu.Lock()
	entries := append([]accessEntry(nil), s.cfg.Entries...)
	s.mu.Unlock()

	// FR-ACL-5a: 수집에 실패해도 loopback 예외는 allowed 안에 따로 있으므로
	// 최후의 탈출구가 사라지지 않는다.
	var self []netip.Addr
	if addrs, err := s.interfaceAddrs(); err == nil {
		self = addrs
	} else {
		log.Printf("access: 인터페이스 주소 수집 실패 (%v) — loopback 예외만 남는다", err)
	}

	resolved := map[string][]netip.Addr{}
	resErr := map[string]string{}
	for _, e := range entries {
		if !isPlainHostname(e.Value) {
			continue
		}
		if _, done := resolved[e.Value]; done {
			continue
		}
		if _, done := resErr[e.Value]; done {
			continue
		}
		hosts, err := s.lookupHost(e.Value)
		if err != nil {
			resErr[e.Value] = err.Error()
			continue
		}
		addrs := make([]netip.Addr, 0, len(hosts))
		for _, h := range hosts {
			if a, err := netip.ParseAddr(h); err == nil {
				addrs = append(addrs, a.Unmap())
			}
		}
		if len(addrs) == 0 {
			resErr[e.Value] = "해석 결과가 없다"
			continue
		}
		resolved[e.Value] = addrs
	}

	s.mu.Lock()
	s.self = self
	s.resolved = resolved
	s.resErr = resErr
	s.mu.Unlock()
}

// startRefresh 는 주기 갱신을 서버 수명에 건다. 인터페이스는 VPN 접속·네트워크
// 전환으로 바뀌고, 호스트명이 가리키는 주소도 바뀐다.
func (s *accessStore) startRefresh(done <-chan struct{}, every time.Duration) {
	go func() {
		t := time.NewTicker(every)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				s.refresh()
			}
		}
	}()
}

func isPlainHostname(v string) bool {
	if _, err := netip.ParseAddr(v); err == nil {
		return false
	}
	if _, err := netip.ParsePrefix(v); err == nil {
		return false
	}
	return isHostname(v)
}

// allowed 는 이 출발지를 들여보낼지의 판정 전부다.
// isSelf 는 그 주소가 **이 기계의 것**인지 본다 (REQUEST_GATE_SRS FR-RQG-6).
//
// `allowed` 와 가르는 이유는 묻는 것이 다르기 때문이다. `allowed` 는 "이 출발지를
// 들여보낼까" 이고 여기는 "이 이름이 나를 가리키나" 다 — 후자는 목록의 켜짐·꺼짐과
// 무관하다. 한 함수로 묶으면 ACL 이 꺼져 있을 때 `allowed` 가 전부 참이 되므로
// Host 판정이 통째로 무력해진다.
func (s *accessStore) isSelf(addr netip.Addr) bool {
	addr = addr.Unmap()
	if addr.IsLoopback() {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range s.self {
		if a == addr {
			return true
		}
	}
	return false
}

// hasHostAlias 는 그 이름이 축②의 활성 항목인지 본다 (FR-ACL-31).
//
// **축①(`Entries`)을 보지 않는다.** 이전에는 `hasHostname` 이 축①의 호스트명
// 항목을 Host 로도 인정했고, 그 자리가 두 축을 섞어 사용자가 축②에 무엇을 적어야
// 하는지 알 수 없게 만들었다 (U-18 · FR-ACL-32). 축①의 항목은 *들여보낼 타 기기*
// 의 이름이므로 이 서버가 그 이름으로 불릴 일이 없다.
//
// **적용 토글과 무관하다** (FR-ACL-26) — Host 판정은 토글과 무관하게 항상 돈다.
// **꺼진 항목은 세지 않는다** (FR-ACL-17 승계).
func (s *accessStore) hasHostAlias(name string) bool {
	if name == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range s.cfg.Hosts {
		if !e.Enabled {
			continue
		}
		// 손으로 고친 `access.json` 은 정규화를 지나지 않았을 수 있다.
		if strings.EqualFold(strings.TrimSuffix(e.Value, "."), name) {
			return true
		}
	}
	return false
}

func (s *accessStore) allowed(addr netip.Addr) bool {
	addr = addr.Unmap()
	s.mu.Lock()
	defer s.mu.Unlock()

	// FR-ACL-5: 자기 주소는 목록·토글과 무관하다. loopback 은 인터페이스 수집이
	// 실패해도 남아야 하므로 목록 대조가 아니라 성질로 판정한다.
	if addr.IsLoopback() {
		return true
	}
	for _, a := range s.self {
		if a == addr {
			return true
		}
	}
	// FR-ACL-7: 꺼져 있으면 전부 통과 — 기존 동작 그대로다.
	if !s.cfg.Enabled {
		return true
	}
	for _, e := range s.cfg.Entries {
		if !e.Enabled {
			continue // FR-ACL-17
		}
		if a, err := netip.ParseAddr(e.Value); err == nil {
			if a.Unmap() == addr {
				return true
			}
			continue
		}
		if p, err := netip.ParsePrefix(e.Value); err == nil {
			if p.Contains(addr) {
				return true
			}
			continue
		}
		// FR-ACL-16: 해석되지 않은 호스트명은 아무도 통과시키지 않는다.
		for _, a := range s.resolved[e.Value] {
			if a == addr {
				return true
			}
		}
	}
	return false
}

func (s *accessStore) view() accessView {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := accessView{Enabled: s.cfg.Enabled, Entries: make([]accessEntryView, 0, len(s.cfg.Entries))}
	for _, e := range s.cfg.Entries {
		ev := accessEntryView{accessEntry: e}
		for _, a := range s.resolved[e.Value] {
			ev.Resolved = append(ev.Resolved, a.String())
		}
		ev.Error = s.resErr[e.Value]
		v.Entries = append(v.Entries, ev)
	}
	for _, a := range s.self {
		v.Self = append(v.Self, a.String())
	}
	// FR-ACL-34: 별명에는 해석 상태가 없다. 저장 모양 그대로 간다.
	v.Hosts = append([]accessEntry(nil), s.cfg.Hosts...)
	return v
}

// remoteIP 는 요청의 출발지다.
//
// **`X-Forwarded-For` 를 보지 않는다** (FR-ACL-6). 클라이언트가 쓸 수 있는 값을
// 신뢰하면 목록이 헤더 한 줄로 무력화된다.
func remoteIP(remoteAddr string) (netip.Addr, bool) {
	host := remoteAddr
	if h, _, err := net.SplitHostPort(remoteAddr); err == nil {
		host = h
	}
	if i := strings.Index(host, "%"); i >= 0 {
		host = host[:i] // zone 제거 (fe80::1%en0)
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return a.Unmap(), true
}

// accessGate 는 목록에 없는 출발지를 끊는다.
//
// **`loggingMiddlewareFor` 안쪽, `recoverMiddleware` 바깥쪽에 선다** (FR-ACL-10).
// 로깅 안쪽이어야 거절이 접근 로그에 남고, 그것이 "목록을 켰는데 접속이 안 된다"
// 를 풀 유일한 근거다. mux 바깥이므로 정적 자산·/api/*·/ws 가 한 겹에 덮인다
// (FR-ACL-11) — 핸들러마다 검사를 뿌리면 새 종단이 생길 때마다 빠뜨린다.
func accessGate(store *accessStore, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if store == nil {
			next.ServeHTTP(w, r)
			return
		}
		addr, ok := remoteIP(r.RemoteAddr)
		if ok && store.allowed(addr) {
			next.ServeHTTP(w, r)
			return
		}
		if !ok && !store.config().Enabled {
			// 출발지를 읽지 못했고 목록도 꺼져 있다 — 막을 근거가 없다.
			next.ServeHTTP(w, r)
			return
		}
		// FR-ACL-13: 출발지와 경로를 남긴다.
		log.Printf("access denied addr=%s %s %s", r.RemoteAddr, r.Method, r.URL.Path)
		// FR-ADP-1: 문서 요청이면 **화면**을 준다 — 평문 `forbidden` 은 사용자가
		// 무엇을 해야 하는지 말하지 않는다. 그 밖(API·/ws)은 그대로 평문이다.
		//
		// FR-ACL-8 은 그대로다: 화면에 실리는 것은 **요청자 자신의 IP** 뿐이고
		// 목록은 한 줄도 나가지 않는다.
		if wantsDeniedPage(r) {
			// **읽지 못했어도 빈칸으로 두지 않는다.** 이 화면의 목적이 "이 주소를
			// 소유자에게 알린다" 이므로, 정규화에 실패했으면 원문이라도 준다 —
			// 알릴 것이 없으면 화면이 있으나 마나다.
			shown := r.RemoteAddr
			if ok {
				shown = addr.String()
			}
			writeDeniedPage(w, shown)
			return
		}
		http.Error(w, "forbidden", http.StatusForbidden)
	})
}

func localInterfaceAddrs() ([]netip.Addr, error) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	out := make([]netip.Addr, 0, len(addrs))
	for _, a := range addrs {
		var ip net.IP
		switch v := a.(type) {
		case *net.IPNet:
			ip = v.IP
		case *net.IPAddr:
			ip = v.IP
		}
		if ip == nil {
			continue
		}
		if na, ok := netip.AddrFromSlice(ip); ok {
			out = append(out, na.Unmap())
		}
	}
	return out, nil
}

// ── 종단 ──────────────────────────────────────────────

func (s *Server) apiAccessGet(w http.ResponseWriter, r *http.Request) {
	if s.Access == nil {
		http.Error(w, "access store unavailable", http.StatusServiceUnavailable)
		return
	}
	v := s.Access.view()
	if addr, ok := remoteIP(r.RemoteAddr); ok {
		v.You = addr.String()
	}
	// FR-ACL-35: 서버가 자기를 무엇으로 아는지(`hostname`)와 지금 어떤 이름으로
	// 불렸는지(`host`)를 함께 준다. U-18 에서 사용자가 알 방법이 없던 둘이다.
	if s.hosts != nil {
		v.Hostname = s.hosts.hostname
	}
	v.Host = normalizeHost(r.Host)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) apiAccessPut(w http.ResponseWriter, r *http.Request) {
	if s.Access == nil {
		http.Error(w, "access store unavailable", http.StatusServiceUnavailable)
		return
	}
	body, err := httpreq.Read(w, r, 0)
	if err != nil {
		http.Error(w, "read body", httpreq.Status(err))
		return
	}
	var cfg accessConfig
	if err := json.Unmarshal(body, &cfg); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if err := s.Access.setConfig(cfg); err != nil {
		if errors.Is(err, errAccessSaveFailed) {
			fail(w, http.StatusInternalServerError, err.Error(), nil)
			return
		}
		// **검증 실패의 사유는 그대로 보인다.** 어느 줄이 잘못됐는지 모르면 사용자가
		// 고칠 수 없다 — `app-settings.js` 의 `_aclSave` 가 이 본문을 그대로 띄운다.
		// 그 문구는 사용자가 방금 보낸 값과 우리가 쓴 설명뿐이다.
		fail(w, http.StatusBadRequest, err.Error(), nil)
		return
	}
	// 저장이 끝난 **뒤에** 알린다 — 받은 창이 곧바로 GET 하므로, 먼저 알리면
	// 그 GET 이 옛 값을 읽을 수 있다 (settings 와 같은 규약).
	if s.Commands != nil {
		s.Commands.Broadcast(accessChangedPayload())
	}
	w.WriteHeader(200)
}

func accessChangedPayload() []byte {
	b, _ := json.Marshal(map[string]any{
		"action": "access_changed",
		"args":   map[string]any{},
	})
	return b
}

// StartAccessRefresh 는 허용 목록의 주기 갱신을 서버 수명에 건다. 다른 Start*
// 와 같은 자리에서 불린다 (cmd/dongminal).
func (s *Server) StartAccessRefresh(done <-chan struct{}) {
	if s.Access == nil {
		return
	}
	s.Access.startRefresh(done, DefaultAccessRefresh)
}
