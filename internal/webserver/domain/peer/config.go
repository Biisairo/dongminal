package peer

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
)

// 노드 설정의 기본값과 상한 (FR-PNW-2·3).
const (
	DefaultPort = 58147
	DefaultBind = "0.0.0.0"
	NameMaxLen  = 32
	// fallbackName 은 호스트 이름에서 아무것도 얻지 못했을 때의 이름이다.
	fallbackName = "node"
	maxPort      = 65535
	fileMode     = 0o600
)

var (
	ErrInvalidName  = errors.New("노드 이름은 영문·숫자·`.`·`_`·`-` 1~32자입니다")
	ErrInvalidPort  = errors.New("포트는 1~65535 입니다")
	ErrInvalidBind  = errors.New("듣는 주소는 IP 주소여야 합니다")
	ErrInvalidPeer  = errors.New("짝 항목의 주소·포트·지문·상태가 틀렸습니다")
	ErrNameTaken    = errors.New("그 이름의 짝이 이미 있습니다")
	ErrPeerNotFound = errors.New("그 이름의 짝이 없습니다")
	// ErrSaveFailed 는 저장 자체의 실패다. 사유는 로그로만 간다.
	ErrSaveFailed = errors.New("노드 설정을 저장하지 못했습니다")
)

// 짝 항목의 상태. 빈 값이 짝이다 (I-2).
const (
	StatePaired     = ""
	StatePendingOut = "pending-out"
)

// Peer 는 짝 하나다. 신원은 Fingerprint 이고 이름·주소는 사용자가 고칠 수 있다.
// State 가 pending-out 이면 상대의 승인을 기다리는 중이고 Expires 에 사라진다.
type Peer struct {
	Name        string    `json:"name"`
	Addr        string    `json:"addr"`
	Port        int       `json:"port"`
	Fingerprint string    `json:"fp"`
	State       string    `json:"state"`
	Expires     time.Time `json:"expires,omitzero"`
}

// Config 는 `peers.json` 전체다 (FR-PNW-2).
type Config struct {
	Enabled     bool     `json:"enabled"`
	Port        int      `json:"port"`
	Bind        string   `json:"bind"`
	Name        string   `json:"name"`
	Advertise   string   `json:"advertise"`
	AllowedDirs []string `json:"allowedDirs"`
	Peers       []Peer   `json:"peers"`
}

func (c Config) clone() Config {
	c.AllowedDirs = append([]string{}, c.AllowedDirs...)
	c.Peers = append([]Peer{}, c.Peers...)
	return c
}

// ValidName 은 FR-PNW-3 의 이름 규칙이다.
func ValidName(name string) error {
	if name == "" || len(name) > NameMaxLen {
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
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-'
}

// DefaultName 은 호스트 이름을 FR-PNW-3 에 맞춘 기본 이름이다. 허용하지 않는 글자는
// `-` 로 바꾸고 32자로 자른다.
func DefaultName(hostname string) string {
	var b strings.Builder
	for _, r := range hostname {
		if b.Len() == NameMaxLen {
			break
		}
		if nameRune(r) {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	if b.Len() == 0 {
		return fallbackName
	}
	return b.String()
}

func defaultConfig(hostname string) Config {
	return Config{
		Port:        DefaultPort,
		Bind:        DefaultBind,
		Name:        DefaultName(hostname),
		AllowedDirs: []string{},
		Peers:       []Peer{},
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
	if c.AllowedDirs == nil {
		c.AllowedDirs = []string{}
	}
	if c.Peers == nil {
		c.Peers = []Peer{}
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
	names := map[string]bool{}
	fps := map[string]bool{}
	for _, p := range c.Peers {
		if err := validatePeer(p); err != nil {
			return err
		}
		if names[p.Name] {
			return ErrNameTaken
		}
		if fps[p.Fingerprint] {
			return ErrInvalidPeer
		}
		names[p.Name] = true
		fps[p.Fingerprint] = true
	}
	return nil
}

func validatePeer(p Peer) error {
	if err := ValidName(p.Name); err != nil {
		return err
	}
	if !ValidAddr(p.Addr) || !validPort(p.Port) || !validFingerprint(p.Fingerprint) {
		return ErrInvalidPeer
	}
	if p.State != StatePaired && p.State != StatePendingOut {
		return ErrInvalidPeer
	}
	return nil
}

// Store 는 `peers.json` 의 주인이다. 서버만 쓴다.
type Store struct {
	mu   sync.Mutex
	path string
	cfg  Config
	now  func() time.Time
}

// OpenStore 는 path 를 읽는다. 없거나 읽지 못하면 꺼진 기본값으로 선다 — 이 파일이
// 서버 기동을 막지 않는다. 열기만으로는 파일을 만들지 않는다 (NFR-PNW-1).
func OpenStore(path, hostname string) *Store {
	def := defaultConfig(hostname)
	s := &Store{path: path, cfg: def, now: time.Now}
	data, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			dmlog.Infof(nil, "loadPeers: %v — 노드 기능을 끈 채로 시작한다", err)
		}
		return s
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		dmlog.Infof(nil, "loadPeers: %v — 노드 기능을 끈 채로 시작한다", err)
		return s
	}
	s.cfg = fillDefaults(c, def)
	return s
}

// live 는 만료되지 않은 항목인가다. 짝은 만료가 없다 (I-2).
func (s *Store) live(p Peer) bool {
	return p.State != StatePendingOut || s.now().Before(p.Expires)
}

// Config 는 지금 값의 사본이다. 만료된 pending-out 은 빠진다.
func (s *Store) Config() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cfg.clone()
	c.Peers = c.Peers[:0]
	for _, p := range s.cfg.Peers {
		if s.live(p) {
			c.Peers = append(c.Peers, p)
		}
	}
	return c
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
		dmlog.Infof(nil, "savePeers: %v", err)
		return ErrSaveFailed
	}
	s.cfg = c
	return nil
}

// update 는 지금 값(만료된 항목을 뺀 것)을 fn 으로 바꿔 저장한다.
func (s *Store) update(fn func(*Config) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cfg.clone()
	c.Peers = c.Peers[:0]
	for _, p := range s.cfg.Peers {
		if s.live(p) {
			c.Peers = append(c.Peers, p)
		}
	}
	if err := fn(&c); err != nil {
		return err
	}
	return s.saveLocked(c)
}

// SetNode 는 노드 설정만 바꾼다. 짝 목록은 그대로다 (I-8).
func (s *Store) SetNode(n Config) error {
	return s.update(func(c *Config) error {
		c.Enabled, c.Port, c.Bind, c.Name, c.Advertise = n.Enabled, n.Port, n.Bind, n.Name, n.Advertise
		c.AllowedDirs = append([]string{}, n.AllowedDirs...)
		return nil
	})
}

func (s *Store) find(fp string) (Peer, bool) {
	if fp == "" {
		return Peer{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.cfg.Peers {
		if p.Fingerprint == fp && s.live(p) {
			return p, true
		}
	}
	return Peer{}, false
}

// IsPeer 는 fp 가 짝의 지문인가다 (FR-PNW-41). pending-out 은 짝이 아니다.
func (s *Store) IsPeer(fp string) bool {
	p, ok := s.find(fp)
	return ok && p.State == StatePaired
}

// IsPendingOut 은 fp 가 만료되지 않은 pending-out 인가다 (FR-PNW-26·27).
func (s *Store) IsPendingOut(fp string) bool {
	p, ok := s.find(fp)
	return ok && p.State == StatePendingOut
}

// NameTaken 은 그 이름을 살아 있는 항목이 쓰고 있는가다.
func (s *Store) NameTaken(name string) bool { return s.nameTakenExcept(name, "") }

// nameTakenExcept 는 지문이 except 인 항목을 빼고 본다.
func (s *Store) nameTakenExcept(name, except string) bool {
	for _, p := range s.Config().Peers {
		if p.Name == name && (except == "" || p.Fingerprint != except) {
			return true
		}
	}
	return false
}

// FreeNameFor 는 base 가 비어 있으면 그대로, 아니면 `-2`·`-3` … 을 붙인 이름이다 (I-5).
// 지문이 fp 인 항목은 AddPeer 가 갈아 끼우므로 그 이름은 비어 있는 것으로 본다.
func (s *Store) FreeNameFor(base, fp string) string {
	if !s.nameTakenExcept(base, fp) {
		return base
	}
	for n := 2; ; n++ {
		suffix := "-" + strconv.Itoa(n)
		head := base
		if len(head)+len(suffix) > NameMaxLen {
			head = head[:NameMaxLen-len(suffix)]
		}
		if name := head + suffix; !s.nameTakenExcept(name, fp) {
			return name
		}
	}
}

// AddPeer 는 짝(또는 pending-out)을 더한다. 같은 지문이 있으면 갈아 끼운다. 이미 짝인
// 지문을 pending-out 으로 다시 더하면 짝으로 남긴다 — 상대가 승인하지 않아도 잃지 않는다.
// 다른 항목이 이미 그 이름을 쓰면 ErrNameTaken 이다 (FR-PNW-30).
func (s *Store) AddPeer(p Peer) error {
	if p.State == StatePaired {
		p.Expires = time.Time{}
	}
	if err := validatePeer(p); err != nil {
		return err
	}
	return s.update(func(c *Config) error {
		kept := c.Peers[:0]
		for _, q := range c.Peers {
			if q.Fingerprint == p.Fingerprint {
				if s.live(q) && q.State == StatePaired {
					p.State, p.Expires = StatePaired, time.Time{}
				}
				continue
			}
			if q.Name == p.Name {
				return ErrNameTaken
			}
			kept = append(kept, q)
		}
		c.Peers = append(kept, p)
		return nil
	})
}

// Promote 는 살아 있는 pending-out 을 짝으로 바꾼다 (FR-PNW-27). 바꿨으면 참이다.
func (s *Store) Promote(fp string) bool {
	if !s.IsPendingOut(fp) {
		return false
	}
	err := s.update(func(c *Config) error {
		for i := range c.Peers {
			if c.Peers[i].Fingerprint == fp {
				c.Peers[i].State = StatePaired
				c.Peers[i].Expires = time.Time{}
			}
		}
		return nil
	})
	return err == nil
}

// Remove 는 그 이름의 항목을 지운다 (FR-PNW-31).
func (s *Store) Remove(name string) error {
	return s.update(func(c *Config) error {
		for i, p := range c.Peers {
			if p.Name == name {
				c.Peers = append(c.Peers[:i], c.Peers[i+1:]...)
				return nil
			}
		}
		return ErrPeerNotFound
	})
}

// SetAddress 는 그 이름의 주소를 고친다. 신원(지문)은 그대로다 (FR-PNW-32).
func (s *Store) SetAddress(name, addr string, port int) error {
	if !ValidAddr(addr) || !validPort(port) {
		return ErrInvalidPeer
	}
	return s.update(func(c *Config) error {
		for i := range c.Peers {
			if c.Peers[i].Name == name {
				c.Peers[i].Addr, c.Peers[i].Port = addr, port
				return nil
			}
		}
		return ErrPeerNotFound
	})
}

// NameOf 는 짝 fp 에 이 노드가 붙인 이름이다 (FR-PNW-91). pending-out 은 짝이 아니다.
func (s *Store) NameOf(fp string) (string, bool) {
	p, ok := s.find(fp)
	if !ok || p.State != StatePaired {
		return "", false
	}
	return p.Name, true
}

// ByName 은 그 이름의 살아 있는 항목이다.
func (s *Store) ByName(name string) (Peer, bool) {
	for _, p := range s.Config().Peers {
		if p.Name == name {
			return p, true
		}
	}
	return Peer{}, false
}
