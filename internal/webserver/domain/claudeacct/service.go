package claudeacct

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

var (
	ErrNotLoggedIn = errors.New("Claude Code 에 로그인한 계정이 없습니다. 먼저 Claude Code 에서 /login 으로 로그인하세요")
	ErrLiveEmpty   = errors.New("활성 자격증명이 없습니다. Claude Code 에서 다시 로그인하세요")
	ErrEmptyBackup = errors.New("이 계정의 백업이 비었습니다. 그 계정으로 로그인한 뒤 다시 추가하세요")
	ErrLiveChanged = errors.New("전환 도중 활성 자격증명이 바뀌었습니다. 다시 시도하세요")
	ErrNoCandidate = errors.New("전환할 계정이 없습니다")
)

// Outgoing 은 전환 때 활성 저장소에 있던 자격증명의 분류다 (FR-CAC-32).
type Outgoing string

const (
	OutgoingSame       Outgoing = "same"
	OutgoingRotated    Outgoing = "rotated"
	OutgoingKnown      Outgoing = "known"
	OutgoingForeign    Outgoing = "foreign"
	OutgoingEmpty      Outgoing = "empty"
	OutgoingUnresolved Outgoing = "unresolved"
)

// SwitchResult 는 전환 결과다.
type SwitchResult struct {
	From     string   `json:"from"`
	To       string   `json:"to"`
	Outgoing Outgoing `json:"outgoing,omitempty"`
	NoOp     bool     `json:"noop,omitempty"`
	// Reason 은 `best` 가 전환하지 않은 이유다 (FR-CAC-31a).
	Reason string `json:"reason,omitempty"`
	// PinnedRunning 은 떠나는 계정이 프로필로 실행 중이었다는 안내다. 전환을 막지 않는다 (FR-CAC-36, D-CAC-28).
	PinnedRunning bool `json:"pinnedRunning,omitempty"`
}

// Service 는 계정 관리와 전환이다. 같은 프로세스 안의 전환은 mu 로, 프로세스 사이는
// 저장소 파일 락으로 직렬화한다.
type Service struct {
	Store       *Store
	Backup      BackupStore
	Live        LiveStore
	Claude      ClaudePaths
	Dir         string
	API         ProfileLookup
	Now         func() time.Time
	NewID       func() string
	LockTimeout time.Duration
	// Alive 는 pid 가 살아 있는가다. 비면 운영체제에 묻는다 (FR-CAC-87).
	Alive func(pid int) bool

	mu sync.Mutex
}

func (s *Service) lockTimeout() time.Duration {
	if s.LockTimeout > 0 {
		return s.LockTimeout
	}
	return DefaultLockWait
}

func (s *Service) configCopy(id string) string {
	return filepath.Join(s.Dir, "configs", id+".json")
}

// AddCurrent 는 지금 로그인한 계정을 등록한다. 이미 있으면 그 계정의 백업을 갱신한다 (FR-CAC-10).
func (s *Service) AddCurrent(_ context.Context) (Account, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	oa, ok, err := ReadOAuthAccount(s.Claude.GlobalConfig)
	if err != nil {
		return Account{}, false, err
	}
	if !ok || oa.EmailAddress == "" {
		return Account{}, false, ErrNotLoggedIn
	}
	live, ok, err := s.Live.Read()
	if err != nil {
		return Account{}, false, err
	}
	if !ok || live.IsEmpty() {
		return Account{}, false, ErrLiveEmpty
	}
	var out Account
	created := false
	err = s.Store.Update(func(st *State) error {
		idx := -1
		for i, a := range st.Accounts {
			if a.Email == oa.EmailAddress && a.OrgUUID == oa.OrganizationUUID {
				idx = i
				break
			}
		}
		if idx < 0 {
			st.Accounts = append(st.Accounts, Account{
				ID: s.NewID(), Email: oa.EmailAddress, OrgUUID: oa.OrganizationUUID,
				AddedAt: s.Now().UTC(), Color: pickColor(st.Accounts),
			})
			idx = len(st.Accounts) - 1
			created = true
		}
		a := &st.Accounts[idx]
		a.AccountUUID, a.OrgName = oa.AccountUUID, oa.OrganizationName
		if err := s.Backup.Write(a.ID, live); err != nil {
			return err
		}
		if err := writeSecretFile(s.configCopy(a.ID), oa.Raw); err != nil {
			return err
		}
		st.ActiveID = a.ID
		out = *a
		return nil
	})
	return out, created, err
}

// Update 는 계정의 별칭·색·문턱값·우선순위·제외를 고친다.
func (s *Service) Update(id string, p Patch) (Account, error) {
	if err := p.Validate(); err != nil {
		return Account{}, err
	}
	var out Account
	err := s.Store.Update(func(st *State) error {
		i := st.Find(id)
		if i < 0 {
			return ErrNotFound
		}
		p.apply(&st.Accounts[i])
		out = st.Accounts[i]
		return nil
	})
	return out, err
}

// Reorder 는 계정 순서를 ids 로 바꾼다. 모든 계정을 한 번씩 담아야 한다.
func (s *Service) Reorder(ids []string) error {
	return s.Store.Update(func(st *State) error {
		if len(ids) != len(st.Accounts) {
			return fmt.Errorf("%w: 모든 계정을 한 번씩 담아야 합니다", ErrInvalid)
		}
		out := make([]Account, 0, len(ids))
		seen := map[string]bool{}
		for _, id := range ids {
			i := st.Find(id)
			if i < 0 || seen[id] {
				return fmt.Errorf("%w: 모든 계정을 한 번씩 담아야 합니다", ErrInvalid)
			}
			seen[id] = true
			out = append(out, st.Accounts[i])
		}
		st.Accounts = out
		return nil
	})
}

// Remove 는 계정과 그 백업을 지운다. 활성 저장소는 건드리지 않는다 (FR-CAC-12).
func (s *Service) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.Store.Update(func(st *State) error {
		i := st.Find(id)
		if i < 0 {
			return ErrNotFound
		}
		st.Accounts = append(st.Accounts[:i], st.Accounts[i+1:]...)
		if st.ActiveID == id {
			st.ActiveID = ""
		}
		return nil
	})
	if err != nil {
		return err
	}
	if err := os.Remove(s.configCopy(id)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := s.dropAccountMappings(id); err != nil {
		return err
	}
	if err := s.removeProfile(id); err != nil {
		return err
	}
	return s.Backup.Delete(id)
}

// classify 는 활성 저장소의 자격증명이 누구의 것인지 정한다 (FR-CAC-32). 네트워크를
// 부를 수 있으므로 락을 잡기 전에 부른다. owner 는 백업할 계정이다.
func (s *Service) classify(ctx context.Context, st State, from string, live Credential, liveOK bool) (Outgoing, string) {
	if !liveOK || live.IsEmpty() {
		return OutgoingEmpty, ""
	}
	fp := live.Fingerprint()
	if from != "" {
		if b, ok, _ := s.Backup.Read(from); ok && b.Fingerprint() == fp {
			if b.AccessToken() == live.AccessToken() {
				return OutgoingSame, from
			}
			return OutgoingRotated, from
		}
	}
	for _, a := range st.Accounts {
		if a.ID == from {
			continue
		}
		if b, ok, _ := s.Backup.Read(a.ID); ok && b.Fingerprint() == fp {
			return OutgoingKnown, a.ID
		}
	}
	idn, err := s.API.Profile(ctx, live.AccessToken())
	if err != nil {
		return OutgoingUnresolved, ""
	}
	for _, a := range st.Accounts {
		if a.AccountUUID != idn.AccountUUID || (idn.OrgUUID != "" && a.OrgUUID != idn.OrgUUID) {
			continue
		}
		if a.ID == from || from == "" {
			return OutgoingRotated, a.ID
		}
		return OutgoingForeign, ""
	}
	return OutgoingForeign, ""
}

// stash 는 주인을 확정하지 못한 자격증명을 버리지 않고 보관한다 (FR-CAC-34).
func (s *Service) stash(c Credential) error {
	raw, err := c.Marshal()
	if err != nil {
		return err
	}
	name := strconv.FormatInt(s.Now().Unix(), 10) + "-" + c.Fingerprint() + ".json"
	return writeSecretFile(filepath.Join(s.Dir, "unclaimed", name), raw)
}

// Switch 는 id 를 활성 계정으로 만든다 (FR-CAC-30). 실패하면 이미 끝낸 단계를 되돌린다.
func (s *Service) Switch(ctx context.Context, id string) (SwitchResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.Store.Load()
	if err != nil {
		return SwitchResult{}, err
	}
	if st.Find(id) < 0 {
		return SwitchResult{}, ErrNotFound
	}
	from := st.ActiveID
	if from == id {
		return SwitchResult{From: from, To: id, NoOp: true}, nil
	}
	pinned := false
	if i := st.Find(from); i >= 0 && s.PinnedRunning(from) {
		s.ReclaimProfile(st.Accounts[i])
		pinned = true
	}
	live, liveOK, err := s.Live.Read()
	if err != nil {
		return SwitchResult{}, err
	}
	kind, owner := s.classify(ctx, st, from, live, liveOK)
	res := SwitchResult{From: from, To: id, Outgoing: kind, PinnedRunning: pinned}

	unlockStore, err := s.Store.Lock()
	if err != nil {
		return res, err
	}
	defer unlockStore()
	releaseClaude, err := lockClaude(s.Claude, s.lockTimeout())
	if err != nil {
		return res, err
	}
	defer releaseClaude()

	again, againOK, err := s.Live.Read()
	if err != nil {
		return res, err
	}
	if againOK != liveOK || again.Fingerprint() != live.Fingerprint() {
		return res, ErrLiveChanged
	}
	target, ok, err := s.Backup.Read(id)
	if err != nil {
		return res, err
	}
	if !ok || target.IsEmpty() {
		return res, ErrEmptyBackup
	}
	cfg, err := os.ReadFile(s.configCopy(id))
	if err != nil || !json.Valid(cfg) {
		return res, ErrEmptyBackup
	}

	switch kind {
	case OutgoingRotated:
		// 프로필에서 회수한 토큰(FR-CAC-86)이 더 새것이면 낡은 활성 토큰으로 덮지 않는다.
		if cur, ok, _ := s.Backup.Read(owner); !ok || live.ExpiresAt() >= cur.ExpiresAt() {
			if err := s.Backup.Write(owner, live); err != nil {
				return res, err
			}
		}
	case OutgoingForeign, OutgoingUnresolved:
		if err := s.stash(live); err != nil {
			return res, err
		}
	}
	if (kind == OutgoingSame || kind == OutgoingRotated) && owner != "" {
		if oa, ok, err := ReadOAuthAccount(s.Claude.GlobalConfig); err == nil && ok {
			_ = writeSecretFile(s.configCopy(owner), oa.Raw)
		}
	}

	next := target
	if liveOK {
		next = target.WithShared(live)
	}
	if err := s.Live.Write(next); err != nil {
		return res, err
	}
	rollbackLive := func() {
		if liveOK {
			_ = s.Live.Write(live)
		}
	}
	prev, err := SpliceOAuthAccount(s.Claude.GlobalConfig, cfg)
	if err != nil {
		rollbackLive()
		return res, err
	}
	err = s.Store.updateLocked(func(st *State) error {
		if st.Find(id) < 0 {
			return ErrNotFound
		}
		st.ActiveID = id
		return nil
	})
	if err != nil {
		_, _ = SpliceOAuthAccount(s.Claude.GlobalConfig, prev)
		rollbackLive()
		return res, err
	}
	return res, nil
}

// nextAfter 는 순서에서 활성 계정 다음의, 제외되지 않았고 ok 를 만족하는 계정이다 (FR-CAC-31 `next`).
func (s *State) nextAfter(ok func(Account) bool) (string, bool) {
	n := len(s.Accounts)
	start := s.Find(s.ActiveID)
	for k := 1; k <= n; k++ {
		a := s.Accounts[(start+k+n)%n]
		if a.ID != s.ActiveID && !a.Disabled && ok(a) {
			return a.ID, true
		}
	}
	return "", false
}
