package httpapi

import (
	"context"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/webserver/action"
	"dongminal/internal/webserver/apierr"
	"encoding/json"
	"errors"
	"net"
	"net/http"

	"net/netip"
	"os"
	"sync"
	"sync/atomic"
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
//
// 이 파일은 저장소(`accessStore`)다. 검증·정규화는 `access_normalize.go`, 판정기는
// `access_matcher.go`, 게이트와 종단은 `access_api.go` 에 있다.

// DefaultAccessRefresh 는 호스트명 해석과 인터페이스 수집의 주기다. 요청 경로는
// 이 결과만 읽는다 (FR-ACL-15).
const DefaultAccessRefresh = 60 * time.Second

// accessLookupTimeout 은 호스트명 하나를 해석하는 시한이다 (REFACTOR3_GO_STRUCT_SRS
// FR-RGS-4). 답하지 않는 리졸버에 갱신이 무기한 묶이지 않게 한다.
const accessLookupTimeout = 3 * time.Second

// accessEntry 는 허용 목록의 한 줄이다. 이것이 디스크에 저장되는 모양이다. 옛 파일의 `label` 은
// 판정에 쓰이지 않던 메모라 읽을 때 버린다 (PROFILE_NAME_SRS FR-PFN-33).
type accessEntry struct {
	ID      string `json:"id"`
	Value   string `json:"value"`
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
	putMu    sync.Mutex // PUT 직렬화. mu 보다 바깥 잠금이다
	mu       sync.Mutex
	path     string
	cfg      accessConfig
	resolved map[string][]netip.Addr // 호스트명 → 해석된 주소
	resErr   map[string]string       // 호스트명 → 해석 실패 사유
	self     []netip.Addr            // 이 머신의 인터페이스 주소 (FR-ACL-5)

	// match 는 요청 경로가 읽는 불변 스냅샷이다 (OPTIMIZE_REFACTOR_SRS FR-OPT-8-2 ·
	// HTTP-4). 위 셋이 바뀌는 자리(setConfig·restore·refresh·적재)에서 mu 를 쥔 채
	// rebuild 로 갈아 끼운다 — 요청마다 전역 락을 잡고 항목을 다시 파싱하지 않는다.
	match atomic.Pointer[accessMatcher]

	// 주입 지점. 테스트가 이 기계의 DNS·인터페이스 상태에 좌우되지 않게 한다.
	lookupHost     func(string) ([]string, error)
	interfaceAddrs func() ([]netip.Addr, error)
}

func newAccessStore(path string) *accessStore {
	s := &accessStore{
		path:           path,
		resolved:       map[string][]netip.Addr{},
		resErr:         map[string]string{},
		lookupHost:     timedLookup(net.DefaultResolver, accessLookupTimeout),
		interfaceAddrs: localInterfaceAddrs,
	}
	s.rebuildLocked()
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			dmlog.Infof(nil, "loadAccess: %v", err)
		}
		return s
	}
	var cfg accessConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		// FR-ACL-2: 읽기 실패가 서버를 잠그지 않는다. 열린 상태로 서고 로그만 남긴다.
		dmlog.Infof(nil, "loadAccess: %v — 허용 목록을 끈 채로 시작한다", err)
		return s
	}
	s.cfg = cfg
	s.rebuildLocked()
	dmlog.Infof(nil, "access loaded: enabled=%v entries=%d hosts=%d", cfg.Enabled, len(cfg.Entries), len(cfg.Hosts))
	return s
}

// timedLookup 은 시한을 둔 호스트명 해석이다.
func timedLookup(r *net.Resolver, within time.Duration) func(string) ([]string, error) {
	return func(host string) ([]string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), within)
		defer cancel()
		return r.LookupHost(ctx, host)
	}
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

// setConfig 는 목록 전체를 교체하고 새 호스트명을 곧바로 해석한다.
func (s *accessStore) setConfig(cfg accessConfig) error {
	if err := s.save(cfg); err != nil {
		return err
	}
	// 새로 들어온 호스트명이 곧바로 상태를 갖게 한다. 이것이 없으면 저장 직후
	// 화면이 "해석 안 됨" 으로 보인다.
	s.refresh()
	return nil
}

// save 는 목록 전체를 교체한다. 해석(refresh)은 하지 않는다 — 설정 PUT 잠금 안에서
// DNS 를 기다리지 않도록 호출자가 잠금 밖에서 부른다 (REFACTOR3_GO_STRUCT_SRS FR-RGS-4).
// **하나라도 유효하지 않으면 아무것도 저장하지 않는다** (FR-ACL-18) — 부분 저장은
// 사용자가 건 규칙과 실제 규칙을 어긋나게 만든다.
func (s *accessStore) save(cfg accessConfig) error {
	norm, err := normalizeAccessConfig(cfg)
	if err != nil {
		return err
	}
	// SAFETY_CORRECTNESS_SRS FR-SAF-1·2 / D-SAF-1: **저장에 실패하면 메모리도
	// 되돌린다.**
	//
	//   이전 동작: 디스크 쓰기 실패를 로그로만 남기고 `nil` 을 돌려주었다 —
	//             `PUT /api/access` 가 200 을 답했다. 메모리에는 반영되므로 그
	//             세션에서는 동작했고, 다음 기동에서 **조용히 열린 서버**가 됐다
	//   새  동작: 쓰기가 실패하면 옛 값으로 되돌리고 `errAccessSaveFailed` 를
	//             돌려준다 (`apiAccessPut` 이 500 으로 옮긴다)
	//   이유:     이것은 접근 허용 목록이다. 디스크와 메모리가 갈리면 다음
	//             기동의 동작을 아무도 예측할 수 없고, 이 목록은 그 불확실성을
	//             감당할 수 있는 대상이 아니다. marshal 실패도 같은 갈래였다 —
	//             `errAccessSaveFailed` 를 돌려주면서 메모리는 바꾼 채 두었다
	s.mu.Lock()
	prev := s.cfg
	s.cfg = norm
	s.rebuildLocked()
	data, err := json.MarshalIndent(s.cfg, "", "  ")
	s.mu.Unlock()
	if err != nil {
		// 문자열과 불뿐인 구조체라 실무에서 나지 않는다. 나더라도 사용자에게 할
		// 말은 없으므로 전문은 로그로만 간다 (04-secops SEC-17).
		dmlog.Infof(nil, "saveAccess marshal: %v", err)
		s.restore(prev)
		return errAccessSaveFailed
	}
	// 원자적으로 쓴다 — 사용자가 손으로 만든 값이고 잘리면 되돌릴 방법이 없다
	// (settings 저장과 같은 근거).
	if err := platform.WriteStateFile(s.path, data, 0o644); err != nil {
		dmlog.Infof(nil, "saveAccess: %v", err)
		s.restore(prev)
		return errAccessSaveFailed
	}
	return nil
}

// restore 는 저장에 실패한 변경을 되돌린다 (FR-SAF-2).
//
// `refresh()` 를 부르지 않는다 — 되돌린 값은 이미 한 번 해석된 것이고, 실패한
// 저장을 위해 DNS 를 다시 칠 이유가 없다.
func (s *accessStore) restore(prev accessConfig) {
	s.mu.Lock()
	s.cfg = prev
	s.rebuildLocked()
	s.mu.Unlock()
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
		dmlog.Errorf(nil, "access: 인터페이스 주소 수집 실패 (%v) — loopback 예외만 남는다", err)
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
	s.rebuildLocked()
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

// checkSave 는 저장하려는 목록이 출발지 `you` 를 잠그는지의 답이다 (SERVER_DRIVEN_ACTIONS_SRS
// X-d). 게이트와 같은 판정기(`buildMatcher`·`allowed`)로 본다 — 자기 주소·IPv6·별칭이 같다.
//
// **모르면 경고하지 않는다.** 해석 기록이 없는 새 호스트명은 저장 뒤에야 해석되므로, 그
// 이름이 출발지를 품을지 지금은 모른다. 확신 없이 경고하면 사용자가 경고를 읽지 않게 된다.
//
// 이 답은 거절이 아니라 확인을 부르는 경고다 (FR-ACL-24) — `setConfig` 는 이것으로 막지 않는다.
func (s *accessStore) checkSave(cfg accessConfig, you netip.Addr) (action.Answer, error) {
	norm, err := normalizeAccessConfig(cfg)
	if err != nil {
		return action.Answer{}, err
	}
	s.mu.Lock()
	m := buildMatcher(norm, s.self, s.resolved)
	unknown := false
	for _, e := range norm.Entries {
		if !e.Enabled || !isPlainHostname(e.Value) {
			continue
		}
		_, ok := s.resolved[e.Value]
		_, failed := s.resErr[e.Value]
		if !ok && !failed {
			unknown = true
		}
	}
	s.mu.Unlock()
	if m.allowed(you) || unknown {
		return action.Allow(), nil
	}
	return action.Deny(http.StatusConflict, apierr.CodeLocksYouOut, map[string]any{"you": you.Unmap().String()}), nil
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
