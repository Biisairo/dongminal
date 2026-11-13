package claudeacct

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unicode/utf8"

	"dongminal/internal/shared/platform"
)

const (
	accountsFile  = "accounts.json"
	storeLockFile = ".lock"
	schemaVersion = 1

	aliasMax     = 24
	thresholdMin = 50.0
	thresholdMax = 99.9
	priorityMin  = 0
	priorityMax  = 1000
)

// palette 는 계정 색의 키다. 실제 색은 테마 토큰(`--acct-1`…)이 정한다 (FR-CAC-98).
var palette = []string{"acct-1", "acct-2", "acct-3", "acct-4", "acct-5", "acct-6", "acct-7", "acct-8"}

var (
	ErrInvalid  = errors.New("값이 범위를 벗어났습니다")
	ErrNotFound = errors.New("계정이 없습니다")
)

// Account 는 등록된 계정이다 (FR-CAC-11). 토큰은 없다.
type Account struct {
	ID          string    `json:"id"`
	Email       string    `json:"email"`
	AccountUUID string    `json:"accountUuid"`
	OrgUUID     string    `json:"organizationUuid"`
	OrgName     string    `json:"organizationName"`
	AddedAt     time.Time `json:"addedAt"`
	Alias       string    `json:"alias,omitempty"`
	Color       string    `json:"color"`
	Disabled    bool      `json:"disabled"`
	Threshold   *float64  `json:"threshold,omitempty"`
	Priority    int       `json:"priority"`
}

// State 는 accounts.json 이다. Accounts 의 순서가 계정 순서다 (FR-CAC-13).
type State struct {
	SchemaVersion int       `json:"schemaVersion"`
	ActiveID      string    `json:"activeId,omitempty"`
	Accounts      []Account `json:"accounts"`
}

// Find 는 id 의 자리다. 없으면 -1.
func (s *State) Find(id string) int {
	for i, a := range s.Accounts {
		if a.ID == id {
			return i
		}
	}
	return -1
}

// Patch 는 계정에서 고칠 수 있는 값이다. nil 은 그대로 둔다.
type Patch struct {
	Alias          *string  `json:"alias,omitempty"`
	Color          *string  `json:"color,omitempty"`
	Disabled       *bool    `json:"disabled,omitempty"`
	Threshold      *float64 `json:"threshold,omitempty"`
	ClearThreshold bool     `json:"clearThreshold,omitempty"`
	Priority       *int     `json:"priority,omitempty"`
}

// Validate 는 범위를 본다 (FR-CAC-11).
func (p Patch) Validate() error {
	if p.Alias != nil && utf8.RuneCountInString(*p.Alias) > aliasMax {
		return fmt.Errorf("%w: 별칭은 %d자 이하입니다", ErrInvalid, aliasMax)
	}
	if p.Color != nil && !validColor(*p.Color) {
		return fmt.Errorf("%w: 알 수 없는 색 %q", ErrInvalid, *p.Color)
	}
	if p.Threshold != nil && !p.ClearThreshold && (*p.Threshold < thresholdMin || *p.Threshold > thresholdMax) {
		return fmt.Errorf("%w: 문턱값은 %.0f~%.1f 입니다", ErrInvalid, thresholdMin, thresholdMax)
	}
	if p.Priority != nil && (*p.Priority < priorityMin || *p.Priority > priorityMax) {
		return fmt.Errorf("%w: 우선순위는 %d~%d 입니다", ErrInvalid, priorityMin, priorityMax)
	}
	return nil
}

func (p Patch) apply(a *Account) {
	if p.Alias != nil {
		a.Alias = *p.Alias
	}
	if p.Color != nil {
		a.Color = *p.Color
	}
	if p.Disabled != nil {
		a.Disabled = *p.Disabled
	}
	if p.ClearThreshold {
		a.Threshold = nil
	} else if p.Threshold != nil {
		v := *p.Threshold
		a.Threshold = &v
	}
	if p.Priority != nil {
		a.Priority = *p.Priority
	}
}

func validColor(c string) bool {
	for _, p := range palette {
		if p == c {
			return true
		}
	}
	return false
}

// pickColor 는 아직 쓰지 않은 첫 색이다. 다 썼으면 계정 수로 돌려 쓴다.
func pickColor(accts []Account) string {
	used := map[string]bool{}
	for _, a := range accts {
		used[a.Color] = true
	}
	for _, c := range palette {
		if !used[c] {
			return c
		}
	}
	return palette[len(accts)%len(palette)]
}

// Store 는 accounts.json 이다. 변경은 파일 락 아래의 읽기-고치기-쓰기다 (FR-CAC-3).
type Store struct {
	mu          sync.Mutex
	dir         string
	LockTimeout time.Duration
}

func OpenStore(dir string) *Store { return &Store{dir: dir, LockTimeout: 10 * time.Second} }

// Dir 은 저장소 폴더다.
func (s *Store) Dir() string { return s.dir }

func (s *Store) load() (State, error) {
	st := State{SchemaVersion: schemaVersion}
	b, err := os.ReadFile(filepath.Join(s.dir, accountsFile))
	if errors.Is(err, os.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(b, &st); err != nil {
		return st, fmt.Errorf("%s: %w", accountsFile, err)
	}
	st.SchemaVersion = schemaVersion
	return st, nil
}

// Load 는 지금 상태다.
func (s *Store) Load() (State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

// Lock 은 저장소 파일 락을 잡는다. 여러 파일을 한 번에 고치는 쪽(전환)이 쓴다.
func (s *Store) Lock() (func(), error) {
	if err := os.MkdirAll(s.dir, dirMode); err != nil {
		return nil, err
	}
	_ = os.Chmod(s.dir, dirMode)
	return platform.LockFile(filepath.Join(s.dir, storeLockFile), s.LockTimeout)
}

// Update 는 락 아래에서 상태를 고친다. fn 이 오류를 내면 아무것도 쓰지 않는다.
func (s *Store) Update(fn func(*State) error) error {
	unlock, err := s.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	return s.updateLocked(fn)
}

// updateLocked 는 이미 Lock 을 잡은 호출부의 Update 다.
func (s *Store) updateLocked(fn func(*State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	if err != nil {
		return err
	}
	if err := fn(&st); err != nil {
		return err
	}
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return platform.WriteFileAtomic(filepath.Join(s.dir, accountsFile), b, fileMode)
}
