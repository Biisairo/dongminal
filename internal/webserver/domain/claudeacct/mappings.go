package claudeacct

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/shared/platform"
)

const (
	mappingsFile     = "mappings.json"
	mappingsLockFile = ".mappings.lock"
	profilesDir      = "profiles"
)

// 해석의 출처 (FR-CAC-81·88).
const (
	SourceTab    = "tab"
	SourceFolder = "folder"
	SourceNone   = "none"
)

// Mapping 은 폴더 매핑이나 탭 지정 하나다.
type Mapping struct {
	AccountID string `json:"accountId"`
}

// Mappings 는 `mappings.json` 이다 (FR-CAC-80).
type Mappings struct {
	Folders map[string]Mapping `json:"folders"`
	Tabs    map[string]Mapping `json:"tabs"`
}

// Resolution 은 계정 해석의 결과다 (FR-CAC-81·88).
type Resolution struct {
	AccountID string `json:"accountId,omitempty"`
	Source    string `json:"source"`
	Folder    string `json:"folder,omitempty"`
	ConfigDir string `json:"configDir,omitempty"`
}

// NormalizeFolder 는 매핑의 키다. 절대 경로여야 한다. 있는 가장 가까운 상위까지 심볼릭 링크를
// 풀고 끝의 구분자를 뗀다. fold 면 소문자로 바꾼다 (FR-CAC-80).
func NormalizeFolder(p string, fold bool) (string, error) {
	if p == "" || !filepath.IsAbs(p) {
		return "", fmt.Errorf("%w: 절대 경로가 필요합니다", ErrInvalid)
	}
	p = filepath.Clean(p)
	rest := ""
	cur := p
	for {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			p = filepath.Join(r, rest)
			break
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		rest = filepath.Join(filepath.Base(cur), rest)
		cur = parent
	}
	if fold {
		p = strings.ToLower(p)
	}
	return p, nil
}

func (s *Service) mappingsPath() string { return filepath.Join(s.Dir, mappingsFile) }

// ProfileDir 은 계정의 프로필 폴더다 (FR-CAC-82).
func (s *Service) ProfileDir(id string) string { return filepath.Join(s.Dir, profilesDir, id) }

func (s *Service) loadMappings() (Mappings, error) {
	m := Mappings{Folders: map[string]Mapping{}, Tabs: map[string]Mapping{}}
	b, err := os.ReadFile(s.mappingsPath())
	if errors.Is(err, os.ErrNotExist) {
		return m, nil
	}
	if err != nil {
		return m, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return Mappings{Folders: map[string]Mapping{}, Tabs: map[string]Mapping{}}, nil
	}
	if m.Folders == nil {
		m.Folders = map[string]Mapping{}
	}
	if m.Tabs == nil {
		m.Tabs = map[string]Mapping{}
	}
	return m, nil
}

// Mappings 는 지금의 폴더 매핑과 탭 지정이다.
func (s *Service) Mappings() (Mappings, error) { return s.loadMappings() }

// updateMappings 는 락 아래에서 매핑을 고친다. fn 이 false 를 돌려주면 쓰지 않는다 (FR-CAC-3).
func (s *Service) updateMappings(fn func(*Mappings) (bool, error)) (bool, error) {
	if err := os.MkdirAll(s.Dir, dirMode); err != nil {
		return false, err
	}
	unlock, err := platform.LockFile(filepath.Join(s.Dir, mappingsLockFile), s.Store.LockTimeout)
	if err != nil {
		return false, err
	}
	defer unlock()
	m, err := s.loadMappings()
	if err != nil {
		return false, err
	}
	changed, err := fn(&m)
	if err != nil || !changed {
		return false, err
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return false, err
	}
	return true, platform.WriteFileAtomic(s.mappingsPath(), b, fileMode)
}

func (s *Service) checkAccount(id string) error {
	st, err := s.Store.Load()
	if err != nil {
		return err
	}
	if st.Find(id) < 0 {
		return ErrNotFound
	}
	return nil
}

// SetFolder 는 폴더 매핑을 건다. accountID 가 비면 지운다.
func (s *Service) SetFolder(path, accountID string) error {
	key, err := NormalizeFolder(path, foldCase)
	if err != nil {
		return err
	}
	if accountID != "" {
		if err := s.checkAccount(accountID); err != nil {
			return err
		}
	}
	_, err = s.updateMappings(func(m *Mappings) (bool, error) {
		if accountID == "" {
			_, ok := m.Folders[key]
			delete(m.Folders, key)
			return ok, nil
		}
		m.Folders[key] = Mapping{AccountID: accountID}
		return true, nil
	})
	return err
}

// SetTab 은 탭 지정을 건다. accountID 가 비면 푼다.
func (s *Service) SetTab(toolID, accountID string) error {
	if toolID == "" {
		return fmt.Errorf("%w: toolId 가 필요합니다", ErrInvalid)
	}
	if accountID != "" {
		if err := s.checkAccount(accountID); err != nil {
			return err
		}
	}
	_, err := s.updateMappings(func(m *Mappings) (bool, error) {
		if accountID == "" {
			_, ok := m.Tabs[toolID]
			delete(m.Tabs, toolID)
			return ok, nil
		}
		m.Tabs[toolID] = Mapping{AccountID: accountID}
		return true, nil
	})
	return err
}

// PruneTabs 는 살아 있지 않은 도구의 탭 지정을 지운다 (FR-CAC-81a). 도구 목록을 아는 때에만 부른다.
func (s *Service) PruneTabs(alive func(toolID string) bool) (bool, error) {
	m, err := s.loadMappings()
	if err != nil {
		return false, err
	}
	dead := false
	for id := range m.Tabs {
		if !alive(id) {
			dead = true
			break
		}
	}
	if !dead {
		return false, nil
	}
	return s.updateMappings(func(m *Mappings) (bool, error) {
		changed := false
		for id := range m.Tabs {
			if !alive(id) {
				delete(m.Tabs, id)
				changed = true
			}
		}
		return changed, nil
	})
}

// dropAccountMappings 는 계정을 가리키는 매핑과 탭 지정을 지운다 (FR-CAC-12).
func (s *Service) dropAccountMappings(id string) error {
	_, err := s.updateMappings(func(m *Mappings) (bool, error) {
		changed := false
		for k, v := range m.Folders {
			if v.AccountID == id {
				delete(m.Folders, k)
				changed = true
			}
		}
		for k, v := range m.Tabs {
			if v.AccountID == id {
				delete(m.Tabs, k)
				changed = true
			}
		}
		return changed, nil
	})
	return err
}

// Resolve 는 ① 탭 지정 ② cwd 와 같거나 가장 가까운 상위의 폴더 매핑 ③ 없음 순으로 계정을 정한다.
// 삭제된 계정을 가리키는 매핑은 없는 것으로 본다 (FR-CAC-81). 프로필은 맞추지 않는다.
func (s *Service) Resolve(toolID, cwd string) (Resolution, error) {
	key, err := NormalizeFolder(cwd, foldCase)
	if err != nil {
		return Resolution{}, err
	}
	st, err := s.Store.Load()
	if err != nil {
		return Resolution{}, err
	}
	m, err := s.loadMappings()
	if err != nil {
		return Resolution{}, err
	}
	found := func(id, source, folder string) Resolution {
		return Resolution{AccountID: id, Source: source, Folder: folder, ConfigDir: s.ProfileDir(id)}
	}
	if t, ok := m.Tabs[toolID]; ok && toolID != "" && st.Find(t.AccountID) >= 0 {
		return found(t.AccountID, SourceTab, ""), nil
	}
	best, bestID := "", ""
	for folder, v := range m.Folders {
		if st.Find(v.AccountID) < 0 || !underFolder(key, folder) {
			continue
		}
		if len(folder) > len(best) {
			best, bestID = folder, v.AccountID
		}
	}
	if bestID != "" {
		return found(bestID, SourceFolder, best), nil
	}
	return Resolution{Source: SourceNone}, nil
}

// underFolder 는 p 가 folder 이거나 그 아래인가다.
func underFolder(p, folder string) bool {
	if p == folder {
		return true
	}
	prefix := folder
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return strings.HasPrefix(p, prefix)
}
