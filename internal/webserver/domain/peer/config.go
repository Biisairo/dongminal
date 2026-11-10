package peer

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"strings"
	"sync"

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
	ErrInvalidName = errors.New("노드 이름은 영문·숫자·`.`·`_`·`-` 1~32자입니다")
	ErrInvalidPort = errors.New("포트는 1~65535 입니다")
	ErrInvalidBind = errors.New("듣는 주소는 IP 주소여야 합니다")
	// ErrSaveFailed 는 저장 자체의 실패다. 사유는 로그로만 간다.
	ErrSaveFailed = errors.New("노드 설정을 저장하지 못했습니다")
)

// Peer 는 짝 하나다. 신원은 Fingerprint 이고 나머지는 사용자가 고칠 수 있다.
type Peer struct {
	Name        string `json:"name"`
	Addr        string `json:"addr"`
	Port        int    `json:"port"`
	Fingerprint string `json:"fp"`
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
	if c.Port < 1 || c.Port > maxPort {
		return ErrInvalidPort
	}
	if _, err := netip.ParseAddr(c.Bind); err != nil {
		return ErrInvalidBind
	}
	return nil
}

// Store 는 `peers.json` 의 주인이다. 서버만 쓴다.
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

// Config 는 지금 값의 사본이다.
func (s *Store) Config() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg.clone()
}

// Save 는 설정 전체를 바꾼다. 틀린 값이 하나라도 있으면 아무것도 바꾸지 않고,
// 쓰기에 실패하면 메모리도 되돌린다 (`access.json` 과 같은 규약).
func (s *Store) Save(c Config) error {
	c = fillDefaults(c.clone(), Config{})
	if err := validate(c); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("%w: %v", ErrSaveFailed, err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := platform.WriteFileAtomic(s.path, data, fileMode); err != nil {
		dmlog.Infof(nil, "savePeers: %v", err)
		return ErrSaveFailed
	}
	s.cfg = c
	return nil
}

// IsPeer 는 fp 가 짝의 지문인가다 (FR-PNW-41).
func (s *Store) IsPeer(fp string) bool {
	if fp == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.cfg.Peers {
		if p.Fingerprint == fp {
			return true
		}
	}
	return false
}
