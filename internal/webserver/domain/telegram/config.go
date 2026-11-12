// Package telegram 은 Telegram 브리지의 도메인이다 (TELEGRAM_BRIDGE_SRS).
//
// 설정은 전용 파일(권한 600)에 둔다 (FR-TGB-2). 일반 설정은 모든 브라우저로 내려가므로
// token 을 둘 수 없다 (D-TGB-12).
package telegram

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
)

const (
	// DefaultSilenceMin 은 PC 입력 뒤 알림을 소리 없이 보내는 시간(분)의 기본값이다 (D-TGB-9).
	DefaultSilenceMin = 5
	// MaxSilenceMin 은 그 상한이다. 하루.
	MaxSilenceMin = 24 * 60
	fileMode      = 0o600
)

var (
	ErrInvalidSilence = errors.New("무음 시간은 0~1440분입니다")
	ErrSaveFailed     = errors.New("Telegram 설정을 저장하지 못했습니다")
)

// Config 는 telegram.json 의 내용이다.
type Config struct {
	Enabled bool   `json:"enabled"`
	Token   string `json:"token"`
	BotName string `json:"botName"`
	// UserID 는 허용 계정이다 (FR-TGB-11). 1:1 대화방의 chat_id 와 같다.
	UserID     int64 `json:"userId"`
	SilenceMin int   `json:"silenceMin"`
}

// View 는 화면으로 가는 값이다. token 을 싣지 않는다 (FR-TGB-3).
type View struct {
	Enabled    bool   `json:"enabled"`
	TokenSet   bool   `json:"tokenSet"`
	BotName    string `json:"botName"`
	Paired     bool   `json:"paired"`
	SilenceMin int    `json:"silenceMin"`
}

func defaultConfig() Config {
	return Config{SilenceMin: DefaultSilenceMin}
}

// Store 는 telegram.json 이다. 틀린 값은 저장하지 않고, 쓰기에 실패하면 메모리도
// 그대로 둔다 (peer.Store 와 같은 규약).
type Store struct {
	mu   sync.Mutex
	path string
	cfg  Config
}

// OpenStore 는 파일을 읽는다. 없거나 깨졌으면 꺼진 기본값으로 시작한다.
func OpenStore(path string) *Store {
	s := &Store{path: path, cfg: defaultConfig()}
	data, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			dmlog.Infof(nil, "telegram: 설정을 읽지 못했다: %v — 끈 채로 시작한다", err)
		}
		return s
	}
	c := defaultConfig()
	if err := json.Unmarshal(data, &c); err != nil {
		dmlog.Infof(nil, "telegram: 설정이 깨졌다: %v — 끈 채로 시작한다", err)
		return s
	}
	s.cfg = c
	return s
}

// Config 는 지금 값의 사본이다.
func (s *Store) Config() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

// View 는 화면용 값이다.
func (s *Store) View() View {
	s.mu.Lock()
	defer s.mu.Unlock()
	return View{Enabled: s.cfg.Enabled, TokenSet: s.cfg.Token != "", BotName: s.cfg.BotName,
		Paired: s.cfg.UserID != 0, SilenceMin: s.cfg.SilenceMin}
}

func (s *Store) update(fn func(*Config) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cfg
	if err := fn(&c); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("%w: %v", ErrSaveFailed, err)
	}
	if err := platform.WriteFileAtomic(s.path, data, fileMode); err != nil {
		dmlog.Infof(nil, "telegram: 설정을 쓰지 못했다: %v", err)
		return ErrSaveFailed
	}
	s.cfg = c
	return nil
}

// SetToken 은 token 과 봇 이름을 바꾼다. token 이 바뀌면 허용 계정을 지운다 (FR-TGB-5).
func (s *Store) SetToken(token, botName string) error {
	return s.update(func(c *Config) error {
		if c.Token != token {
			c.UserID = 0
		}
		c.Token, c.BotName = token, botName
		return nil
	})
}

func (s *Store) SetEnabled(on bool) error {
	return s.update(func(c *Config) error { c.Enabled = on; return nil })
}

func (s *Store) SetSilence(min int) error {
	if min < 0 || min > MaxSilenceMin {
		return ErrInvalidSilence
	}
	return s.update(func(c *Config) error { c.SilenceMin = min; return nil })
}

// SetUser 는 허용 계정을 바꾼다. 0 이면 해제다.
func (s *Store) SetUser(id int64) error {
	return s.update(func(c *Config) error { c.UserID = id; return nil })
}
