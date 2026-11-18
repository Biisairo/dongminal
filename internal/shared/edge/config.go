package edge

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
)

// 노드 설정의 기본값과 상한 (FR-PNW-2·3).
const (
	DefaultPort = 58147
	DefaultBind = "0.0.0.0"
	NameMaxLen  = 32
	// NameMaxBytes 는 이름의 UTF-8 바이트 상한이다. 상대의 DisplayNameMax 와 같다 (PROFILE_NAME_SRS FR-PFN-2).
	NameMaxBytes = DisplayNameMax
	// fallbackName 은 호스트 이름에서 아무것도 얻지 못했을 때의 이름이다.
	fallbackName = "node"
	maxPort      = 65535
	fileMode     = 0o600
)

var (
	ErrInvalidName  = errors.New("이름은 영문·한글·숫자·`_`·`-` 1~32자(64바이트 이내)입니다")
	ErrInvalidPort  = errors.New("포트는 1~65535 입니다")
	ErrInvalidBind  = errors.New("듣는 주소는 IP 주소여야 합니다")
	ErrInvalidEdge  = errors.New("간선 항목의 이름·주소·포트·지문이 틀렸습니다")
	ErrEdgeNotFound = errors.New("그 지문의 간선이 없습니다")
	// ErrAmbiguous 는 지문 앞자리가 간선 둘 이상에 맞는다는 뜻이다 (EDGE_PAIRING_SRS FR-EPR-30).
	ErrAmbiguous = errors.New("지문 앞자리가 간선 둘 이상에 맞습니다")
	// ErrInvalidNodeField 는 허용 폴더(절대 경로)·알릴 주소(주소)가 틀렸다는 뜻이다.
	ErrInvalidNodeField = errors.New("허용 폴더는 절대 경로, 알릴 주소는 IP 주소나 호스트명이어야 합니다")
	// ErrSaveFailed 는 저장 자체의 실패다. 사유는 로그로만 간다.
	ErrSaveFailed = errors.New("노드 설정을 저장하지 못했습니다")
)

// 간선 찾기와 표시 이름의 한도 (EDGE_PAIRING_SRS FR-EPR-8·30).
const (
	// MinPrefix 는 간선을 찾을 때 받는 지문 앞자리의 최소 길이다.
	MinPrefix = 8
	// DisplayNameMax 는 상대가 알린 표시 이름의 바이트 상한이다.
	DisplayNameMax = 64
	fingerprintLen = 64
)

// Edge 는 간선 하나다. 신원은 Fingerprint 다. Name 은 상대가 알린 표시 이름이라 겹쳐도
// 된다. 상대의 노드 포트가 닫혀 있었으면 Addr·Port 가 비어 있고, 이 노드는 걸지 않는다
// (EDGE_PAIRING_SRS FR-EPR-2·31·80).
type Edge struct {
	Name        string `json:"name"`
	Addr        string `json:"addr"`
	Port        int    `json:"port"`
	Fingerprint string `json:"fp"`
	// HelperKey 는 상대 도우미의 공개키다. 채팅 연결로 처음 받은 값을 고정한다 (PEER_CHAT_SRS FR-PCH-74).
	HelperKey string `json:"helperKey,omitempty"`
}

// Config 는 `edges.json` 전체다 (FR-PNW-2).
type Config struct {
	Enabled   bool   `json:"enabled"`
	Port      int    `json:"port"`
	Bind      string `json:"bind"`
	Name      string `json:"name"`
	Advertise string `json:"advertise"`
	// 옛 파일의 allowedDirs 는 읽을 때 버린다 (PEER_DAEMON_SRS FR-PDM-65).
	Edges []Edge `json:"edges"`
}

func (c Config) clone() Config {
	c.Edges = append([]Edge{}, c.Edges...)
	return c
}

// ValidName 은 이름 규칙이다 (PROFILE_NAME_SRS FR-PFN-2).
func ValidName(name string) error {
	if name == "" || utf8.RuneCountInString(name) > NameMaxLen || len(name) > NameMaxBytes {
		return ErrInvalidName
	}
	for _, r := range name {
		if !nameRune(r) {
			return ErrInvalidName
		}
	}
	return nil
}

func nameRune(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-' ||
		r >= '가' && r <= '힣'
}

// ValidDisplayName 은 표시 이름 규칙이다: 비지 않고, 64바이트 안이며, 제어 문자가 없다.
func ValidDisplayName(name string) bool {
	if name == "" || len(name) > DisplayNameMax || !utf8.ValidString(name) {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) || unicode.Is(unicode.Cf, r) {
			return false
		}
	}
	return true
}

// DisplayName 은 상대가 알린 이름이다. 규칙에 맞지 않으면 거절하지 않고 DefaultName 으로
// 고친다 (FR-EPR-8).
func DisplayName(name string) string {
	if ValidDisplayName(name) {
		return name
	}
	return DefaultName(name)
}

// DefaultName 은 hostname 을 FR-PFN-2 에 맞춘 이름이다. 허용하지 않는 글자는 `-` 로 바꾸고
// 길이 상한 안으로 자른다 (FR-PFN-3).
func DefaultName(hostname string) string {
	var b strings.Builder
	n := 0
	for _, r := range hostname {
		if !nameRune(r) {
			r = '-'
		}
		if n == NameMaxLen || b.Len()+utf8.RuneLen(r) > NameMaxBytes {
			break
		}
		b.WriteRune(r)
		n++
	}
	if b.Len() == 0 {
		return fallbackName
	}
	return b.String()
}

func defaultConfig(hostname string) Config {
	return Config{
		Port:  DefaultPort,
		Bind:  DefaultBind,
		Name:  DefaultName(hostname),
		Edges: []Edge{},
	}
}

// fillDefaults 는 파일에 없던 필드를 기본값으로 채운다.
func fillDefaults(c Config, def Config) Config {
	if c.Port == 0 {
		c.Port = def.Port
	}
	if c.Bind == "" {
		c.Bind = def.Bind
	}
	if c.Name == "" {
		c.Name = def.Name
	}
	if c.Edges == nil {
		c.Edges = []Edge{}
	}
	return c
}

func validate(c Config) error {
	if err := ValidName(c.Name); err != nil {
		return err
	}
	if !validPort(c.Port) {
		return ErrInvalidPort
	}
	if _, err := netip.ParseAddr(c.Bind); err != nil {
		return ErrInvalidBind
	}
	fps := map[string]bool{}
	for _, p := range c.Edges {
		if err := validateEdge(p); err != nil {
			return err
		}
		if fps[p.Fingerprint] {
			return ErrInvalidEdge
		}
		fps[p.Fingerprint] = true
	}
	return nil
}

// validateEdge 는 간선 하나다. 주소와 포트는 함께 있거나 함께 비어 있다 (FR-EPR-80).
func validateEdge(p Edge) error {
	if !ValidDisplayName(p.Name) || !validFingerprint(p.Fingerprint) {
		return ErrInvalidEdge
	}
	if p.Addr == "" && p.Port == 0 {
		return nil
	}
	if !ValidAddr(p.Addr) || !validPort(p.Port) {
		return ErrInvalidEdge
	}
	return nil
}

// Store 는 `edges.json` 의 주인이다. 노드를 처리하는 프로세스만 쓴다.
type Store struct {
	mu   sync.Mutex
	path string
	cfg  Config
}

// OpenStore 는 path 를 읽는다. 없거나 읽지 못하면 꺼진 기본값으로 선다 — 이 파일이
// 서버 기동을 막지 않는다. 열기만으로는 파일을 만들지 않는다 (NFR-PNW-1).
func OpenStore(path, hostname string) *Store {
	def := defaultConfig(hostname)
	s := &Store{path: path, cfg: def}
	data, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			dmlog.Infof(nil, "loadEdges: %v — 노드 기능을 끈 채로 시작한다", err)
		}
		return s
	}
	// 옛 항목의 state 가 빈 값(짝)이 아니면(pending-out) 버린다 (FR-EPR-80).
	type stored struct {
		Edge
		State string `json:"state"`
	}
	var c struct {
		Config
		Edges []stored `json:"edges"`
		// LegacyEdges 는 옛 키 peers 다. edges 가 없을 때만 쓴다 (PEER_DAEMON_SRS §3.4a).
		LegacyEdges []stored `json:"peers"`
	}
	if err := json.Unmarshal(data, &c); err != nil {
		dmlog.Infof(nil, "loadEdges: %v — 노드 기능을 끈 채로 시작한다", err)
		return s
	}
	if c.Edges == nil {
		c.Edges = c.LegacyEdges
	}
	c.Config.Edges = []Edge{}
	for _, e := range c.Edges {
		if e.State == "" {
			c.Config.Edges = append(c.Config.Edges, e.Edge)
		}
	}
	s.cfg = fillDefaults(c.Config, def)
	if ValidName(s.cfg.Name) != nil {
		s.cfg.Name = DefaultName(s.cfg.Name)
	}
	return s
}

// MigrateLegacyFiles 는 옛 이름의 홈 파일을 정리한다 (PEER_DAEMON_SRS FR-PDM-71).
// edges.json 이 없고 peers.json 이 있으면 이름을 바꾼다. 둘 다 있으면 그대로 둔다.
// 옛 신원 파일 node-*.pem 은 옮기지 않고 지운다 — 신원은 edge-*.pem 으로 새로 선다 (D-PDM-18).
func MigrateLegacyFiles(dir string) error {
	for _, n := range []string{dmenv.LegacyNodeCertFile, dmenv.LegacyNodeKeyFile} {
		if err := os.Remove(filepath.Join(dir, n)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	cur := filepath.Join(dir, dmenv.EdgesFile)
	if _, err := os.Stat(cur); !errors.Is(err, os.ErrNotExist) {
		return err
	}
	err := os.Rename(filepath.Join(dir, dmenv.LegacyPeersFile), cur)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// Config 는 지금 값의 사본이다.
func (s *Store) Config() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg.clone()
}

// Save 는 설정 전체를 바꾼다. 틀린 값이 하나라도 있으면 아무것도 바꾸지 않고,
// 쓰기에 실패하면 메모리도 그대로 둔다 (`access.json` 과 같은 규약).
func (s *Store) Save(c Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.saveLocked(c)
}

func (s *Store) saveLocked(c Config) error {
	c = fillDefaults(c.clone(), Config{})
	if err := validate(c); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("%w: %v", ErrSaveFailed, err)
	}
	if err := platform.WriteFileAtomic(s.path, data, fileMode); err != nil {
		dmlog.Infof(nil, "saveEdges: %v", err)
		return ErrSaveFailed
	}
	s.cfg = c
	return nil
}

// update 는 지금 값을 fn 으로 바꿔 저장한다.
func (s *Store) update(fn func(*Config) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cfg.clone()
	if err := fn(&c); err != nil {
		return err
	}
	return s.saveLocked(c)
}

// PinHelper 는 짝 fp 의 도우미 공개키를 고정한다. 이미 고정한 값은 바꾸지 않는다
// (PEER_CHAT_SRS FR-PCH-74). 간선을 지우고 다시 맺으면 새로 고정한다.
func (s *Store) PinHelper(fp, key string) error {
	return s.update(func(c *Config) error {
		for i := range c.Edges {
			e := &c.Edges[i]
			if e.Fingerprint == fp && e.HelperKey == "" {
				e.HelperKey = key
			}
		}
		return nil
	})
}

// SetNode 는 노드 설정만 바꾼다. 짝 목록은 그대로다 (I-8).
//
// 알릴 주소는 여기서만 거른다. 저장 전체의 validate 에 두면 이미 저장된 옛 값
// 하나 때문에 짝 추가 같은 다른 저장까지 막힌다 (리뷰 C-2·C-7).
func (s *Store) SetNode(n Config) error {
	if n.Advertise != "" && !ValidAddr(n.Advertise) {
		return ErrInvalidNodeField
	}
	return s.update(func(c *Config) error {
		c.Enabled, c.Port, c.Bind, c.Advertise = n.Enabled, n.Port, n.Bind, n.Advertise
		// 이름은 프로필에서 바꾼다. 빈 값이면 지금 이름을 둔다 (PROFILE_NAME_SRS FR-PFN-31).
		if n.Name != "" {
			c.Name = n.Name
		}
		return nil
	})
}

// SetName 은 이름만 바꾼다 (PROFILE_NAME_SRS FR-PFN-1·11).
func (s *Store) SetName(name string) error {
	if err := ValidName(name); err != nil {
		return err
	}
	return s.update(func(c *Config) error {
		c.Name = name
		return nil
	})
}

// IsEdge 는 fp 가 간선의 지문인가다.
func (s *Store) IsEdge(fp string) bool {
	_, err := s.Resolve(fp)
	return err == nil && len(fp) == fingerprintLen
}

// Resolve 는 지문 전체나 앞자리(MinPrefix 자리 이상)로 간선 하나를 찾는다. 둘 이상에
// 맞으면 ErrAmbiguous, 없거나 너무 짧으면 ErrEdgeNotFound 다 (FR-EPR-30).
func (s *Store) Resolve(q string) (Edge, error) {
	q = strings.ToLower(strings.TrimSpace(q))
	if strings.Contains(q, "#") {
		return s.resolveHandle(q)
	}
	if len(q) < MinPrefix {
		return Edge{}, ErrEdgeNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var found []Edge
	for _, e := range s.cfg.Edges {
		if e.Fingerprint == q {
			return e, nil
		}
		if strings.HasPrefix(e.Fingerprint, q) {
			found = append(found, e)
		}
	}
	switch len(found) {
	case 0:
		return Edge{}, ErrEdgeNotFound
	case 1:
		return found[0], nil
	}
	return Edge{}, ErrAmbiguous
}

// resolveHandle 은 핸들 `이름#번호` 로 간선 하나를 찾는다. 이름은 대소문자를 가리지 않는다
// (PROFILE_NAME_SRS FR-PFN-24).
func (s *Store) resolveHandle(q string) (Edge, error) {
	i := strings.LastIndex(q, "#")
	name, num := q[:i], q[i+1:]
	if name == "" || num == "" {
		return Edge{}, ErrEdgeNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var found []Edge
	for _, e := range s.cfg.Edges {
		if strings.EqualFold(e.Name, name) && Tag(e.Fingerprint) == num {
			found = append(found, e)
		}
	}
	switch len(found) {
	case 0:
		return Edge{}, ErrEdgeNotFound
	case 1:
		return found[0], nil
	}
	return Edge{}, ErrAmbiguous
}

// AddEdge 는 간선을 더한다. 같은 지문이 있으면 이름·주소만 바꾸고 고정한 도우미 키는
// 넘겨받는다 — 도우미 키는 간선을 지울 때만 사라진다 (FR-EPR-7, PEER_CHAT_SRS §3.12a R-2).
func (s *Store) AddEdge(p Edge) error {
	if err := validateEdge(p); err != nil {
		return err
	}
	return s.update(func(c *Config) error {
		for i, q := range c.Edges {
			if q.Fingerprint != p.Fingerprint {
				continue
			}
			if p.HelperKey == "" {
				p.HelperKey = q.HelperKey
			}
			c.Edges[i] = p
			return nil
		}
		c.Edges = append(c.Edges, p)
		return nil
	})
}

// Remove 는 지문이 fp 인 간선을 지운다.
func (s *Store) Remove(fp string) error {
	return s.update(func(c *Config) error {
		for i, p := range c.Edges {
			if p.Fingerprint == fp {
				c.Edges = append(c.Edges[:i], c.Edges[i+1:]...)
				return nil
			}
		}
		return ErrEdgeNotFound
	})
}

// SetAddress 는 지문이 fp 인 간선의 주소를 고친다. 신원(지문)은 그대로다 (FR-EPR-52).
func (s *Store) SetAddress(fp, addr string, port int) error {
	if !ValidAddr(addr) || !validPort(port) {
		return ErrInvalidEdge
	}
	return s.update(func(c *Config) error {
		for i := range c.Edges {
			if c.Edges[i].Fingerprint == fp {
				c.Edges[i].Addr, c.Edges[i].Port = addr, port
				return nil
			}
		}
		return ErrEdgeNotFound
	})
}
