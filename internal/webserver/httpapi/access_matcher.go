package httpapi

import (
	"net/netip"
	"strings"
)

// 허용 목록의 판정기 — 요청 경로가 읽는 불변 스냅샷(`accessMatcher`)과 그 조회
// (OPTIMIZE_REFACTOR_SRS FR-OPT-8-2).

// isSelf 는 그 주소가 **이 기계의 것**인지 본다 (REQUEST_GATE_SRS FR-RQG-6).
//
// `allowed` 와 가르는 이유는 묻는 것이 다르기 때문이다. `allowed` 는 "이 출발지를
// 들여보낼까" 이고 여기는 "이 이름이 나를 가리키나" 다 — 후자는 목록의 켜짐·꺼짐과
// 무관하다. 한 함수로 묶으면 ACL 이 꺼져 있을 때 `allowed` 가 전부 참이 되므로
// Host 판정이 통째로 무력해진다.
func (s *accessStore) isSelf(addr netip.Addr) bool {
	return s.match.Load().isSelf(addr.Unmap())
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
	_, ok := s.match.Load().aliases[strings.ToLower(name)]
	return ok
}

// allowed 는 이 출발지를 들여보낼지의 판정 전부다.
func (s *accessStore) allowed(addr netip.Addr) bool {
	return s.match.Load().allowed(addr)
}

// allowed 는 판정기 하나의 판정이다. 게이트와 잠김 묻기(`checkSave`)가 같이 부른다.
func (m *accessMatcher) allowed(addr netip.Addr) bool {
	addr = addr.Unmap()
	// FR-ACL-5: 자기 주소는 목록·토글과 무관하다. loopback 은 인터페이스 수집이
	// 실패해도 남아야 하므로 목록 대조가 아니라 성질로 판정한다.
	if m.isSelf(addr) {
		return true
	}
	// FR-ACL-7: 꺼져 있으면 전부 통과 — 기존 동작 그대로다.
	if !m.enabled {
		return true
	}
	if _, ok := m.addrs[addr]; ok {
		return true
	}
	for _, p := range m.prefixes {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

// accessMatcher 는 판정에 필요한 것을 미리 파싱해 둔 불변 스냅샷이다 (HTTP-4).
type accessMatcher struct {
	enabled  bool
	self     map[netip.Addr]struct{}
	addrs    map[netip.Addr]struct{} // 켜진 IP 항목 + 켜진 호스트명의 해석 결과
	prefixes []netip.Prefix          // 켜진 CIDR 항목
	aliases  map[string]struct{}     // 켜진 축② 이름 (소문자, 끝 점 없음)
}

// isSelf 와 allowed 의 판정은 나뉘어 있다(위 isSelf 주석). 공유하는 것은 자기 집합
// 조회뿐이다.
func (m *accessMatcher) isSelf(addr netip.Addr) bool {
	if addr.IsLoopback() {
		return true
	}
	_, ok := m.self[addr]
	return ok
}

// rebuildLocked 는 cfg·self·resolved 로 스냅샷을 새로 만든다. s.mu 를 쥔 채 부른다.
func (s *accessStore) rebuildLocked() {
	s.match.Store(buildMatcher(s.cfg, s.self, s.resolved))
}

// buildMatcher 는 설정 하나와 이 기계의 사실(자기 주소·해석 결과)로 판정기를 만든다.
func buildMatcher(cfg accessConfig, self []netip.Addr, resolved map[string][]netip.Addr) *accessMatcher {
	m := &accessMatcher{
		enabled: cfg.Enabled,
		self:    make(map[netip.Addr]struct{}, len(self)),
		addrs:   map[netip.Addr]struct{}{},
		aliases: map[string]struct{}{},
	}
	for _, a := range self {
		m.self[a] = struct{}{}
	}
	for _, e := range cfg.Entries {
		if !e.Enabled {
			continue // FR-ACL-17
		}
		if a, err := netip.ParseAddr(e.Value); err == nil {
			m.addrs[a.Unmap()] = struct{}{}
			continue
		}
		if p, err := netip.ParsePrefix(e.Value); err == nil {
			m.prefixes = append(m.prefixes, p)
			continue
		}
		// FR-ACL-16: 해석되지 않은 호스트명은 아무도 통과시키지 않는다.
		for _, a := range resolved[e.Value] {
			m.addrs[a] = struct{}{}
		}
	}
	// FR-ACL-31: 축②의 켜진 항목만. 손으로 고친 `access.json` 은 정규화를 지나지
	// 않았을 수 있다 — 대소문자와 끝 점을 여기서 맞춘다.
	for _, e := range cfg.Hosts {
		if e.Enabled {
			m.aliases[strings.ToLower(strings.TrimSuffix(e.Value, "."))] = struct{}{}
		}
	}
	return m
}
