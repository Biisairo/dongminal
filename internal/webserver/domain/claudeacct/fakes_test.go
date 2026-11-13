package claudeacct

import (
	"context"
	"errors"
	"sync"
)

// memSecrets 는 platform.Secrets 의 메모리 구현이다.
type memSecrets struct {
	mu       sync.Mutex
	items    map[string]string
	off      bool
	failSet  bool
	failGet  bool
	setCalls int
}

func newMemSecrets() *memSecrets { return &memSecrets{items: map[string]string{}} }

func (m *memSecrets) key(s, a string) string { return s + "\x00" + a }
func (m *memSecrets) Available() bool        { return !m.off }
func (m *memSecrets) Account() string        { return "tester" }

func (m *memSecrets) Get(s, a string) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.off {
		return "", false, errors.New("unavailable")
	}
	if m.failGet {
		return "", false, errors.New("keychain broken")
	}
	v, ok := m.items[m.key(s, a)]
	return v, ok, nil
}

func (m *memSecrets) Set(s, a, v string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.setCalls++
	if m.off || m.failSet {
		return errors.New("set failed")
	}
	m.items[m.key(s, a)] = v
	return nil
}

func (m *memSecrets) Delete(s, a string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.items, m.key(s, a))
	return nil
}

// fakeProfile 는 ProfileLookup 이다. 토큰마다 정체를 돌려준다.
type fakeProfile struct {
	byToken map[string]Identity
	calls   int
	err     error
}

func (f *fakeProfile) Profile(_ context.Context, token string) (Identity, error) {
	f.calls++
	if f.err != nil {
		return Identity{}, f.err
	}
	id, ok := f.byToken[token]
	if !ok {
		return Identity{}, errors.New("unknown token")
	}
	return id, nil
}
