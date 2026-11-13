package claudeacct

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/platform"
)

const (
	onboardingKey = "hasCompletedOnboarding"
	sessionsDir   = "sessions"
)

// accountConfigKeys 는 프로필이 기본 설정에서 가져오지 않는 계정 항목이다 (FR-CAC-82, D-CAC-26).
// 이름에 `Cache` 가 들어가거나 `cached` 로 시작하는 항목도 계정 항목이다.
var accountConfigKeys = map[string]bool{
	oauthAccountKey:                true,
	"userID":                       true,
	"claudeCodeFirstTokenDate":     true,
	"passesLastSeenRemaining":      true,
	"penguinModeOrgEnabled":        true,
	"managedSettingsNoticeSeenOrg": true,
}

func isAccountConfigKey(k string) bool {
	return accountConfigKeys[k] || strings.Contains(k, "Cache") || strings.HasPrefix(k, "cached")
}

// sharedItems 는 프로필이 `~/.claude` 의 것을 그대로 쓰는 항목이다 (FR-CAC-82).
var sharedItems = []string{
	"settings.json", "keybindings.json", "CLAUDE.md", "skills", "commands",
	"agents", "rules", "plugins", "projects", "history.jsonl",
}

// ProfileLive 는 계정 프로필의 자격증명 저장소다. macOS 는 프로필 키체인, 그 밖은 프로필의
// `.credentials.json` 이다 (FR-CAC-82).
func (s *Service) ProfileLive(id string) LiveStore {
	return LiveStore{Paths: ProfileClaudePaths(s.ProfileDir(id)), Sec: s.Live.Sec, RetryDelay: s.Live.RetryDelay}
}

// PrepareProfile 은 프로필 폴더를 만들고 자격증명·`.claude.json`·공유 항목을 맞춘다 (FR-CAC-82).
// warnings 는 잇지 못한 공유 항목 이름이다.
func (s *Service) PrepareProfile(id string) (string, []string, error) {
	st, err := s.Store.Load()
	if err != nil {
		return "", nil, err
	}
	i := st.Find(id)
	if i < 0 {
		return "", nil, ErrNotFound
	}
	acc := st.Accounts[i]
	dir := s.ProfileDir(id)
	if err := os.MkdirAll(dir, dirMode); err != nil {
		return "", nil, err
	}
	_ = os.Chmod(dir, dirMode)
	backup, ok, err := s.Backup.Read(id)
	if err != nil {
		return "", nil, err
	}
	if !ok || backup.IsEmpty() {
		return "", nil, ErrEmptyBackup
	}
	cfg, err := os.ReadFile(s.configCopy(id))
	if err != nil || !json.Valid(cfg) {
		return "", nil, ErrEmptyBackup
	}
	s.ReclaimProfile(acc)
	if backup, _, err = s.Backup.Read(id); err != nil {
		return "", nil, err
	}
	paths := ProfileClaudePaths(dir)
	release, err := lockClaude(paths, s.lockTimeout())
	if err != nil {
		return "", nil, err
	}
	defer release()
	pl := s.ProfileLive(id)
	cur, curOK, err := pl.Read()
	if err != nil && !errors.Is(err, ErrKeychainUnavailable) {
		return "", nil, err
	}
	if !curOK || cur.IsEmpty() || cur.ExpiresAt() < backup.ExpiresAt() {
		if err := pl.Write(backup); err != nil {
			return "", nil, err
		}
	}
	if err := s.mergeProfileConfig(paths.GlobalConfig, cfg); err != nil {
		return "", nil, err
	}
	link := s.LinkShared
	if link == nil {
		link = defaultLinker().link
	}
	warn := link(s.Claude.ConfigHome, dir)
	s.setProfileWarnings(id, warn)
	for _, w := range warn {
		dmlog.Infof(nil, "claude-accounts: 프로필 %s 의 공유 항목 %s 를 잇지 못했다", id, w)
	}
	return dir, warn, nil
}

// mergeProfileConfig 는 기본 설정의 최상위 항목을 프로필 설정에 덮어쓴다. 계정 항목은 프로필의 값을
// 두고, `oauthAccount` 는 계정 사본으로, 온보딩은 끝난 것으로 둔다 (D-CAC-26).
func (s *Service) mergeProfileConfig(path string, oauth json.RawMessage) error {
	out, _, err := readConfigMap(path)
	if err != nil || out == nil {
		out = map[string]json.RawMessage{}
	}
	if def, ok, err := readConfigMap(s.Claude.GlobalConfig); err == nil && ok {
		for k, v := range def {
			if !isAccountConfigKey(k) {
				out[k] = v
			}
		}
	}
	out[oauthAccountKey] = oauth
	out[onboardingKey] = json.RawMessage("true")
	b, err := json.Marshal(out)
	if err != nil {
		return err
	}
	return platform.WriteFileAtomic(path, b, fileMode)
}

// sharedLinker 는 공유 항목을 잇는다. 이음매는 시험이 링크 실패를 흉내 내기 위한 것이다.
type sharedLinker struct {
	symlink  func(src, dst string) error
	junction func(src, dst string) error
}

func defaultLinker() sharedLinker {
	return sharedLinker{symlink: os.Symlink, junction: platform.Junction}
}

// link 는 home 의 공유 항목을 dir 에 잇는다. 원본이 없는 항목은 건너뛴다. 프로필에 진짜 폴더가
// 이미 있으면 그대로 둔다. 링크를 만들 수 없으면 파일은 복사, 폴더는 정션이고 그것도 실패하면
// 그 이름을 돌려준다.
func (l sharedLinker) link(home, dir string) []string {
	var warn []string
	for _, name := range sharedItems {
		src, dst := filepath.Join(home, name), filepath.Join(dir, name)
		sst, err := os.Stat(src)
		if err != nil {
			continue
		}
		if dt, err := os.Lstat(dst); err == nil {
			switch {
			case dt.Mode()&os.ModeSymlink != 0:
				if got, _ := os.Readlink(dst); got == src {
					continue
				}
				_ = os.Remove(dst)
			case dt.Mode().IsRegular() && sst.Mode().IsRegular():
				// 지난번의 복사본이다. 다시 복사한다.
				if err := copySharedFile(src, dst); err != nil {
					warn = append(warn, name)
				}
				continue
			default:
				continue
			}
		}
		if l.symlink(src, dst) == nil {
			continue
		}
		if sst.IsDir() {
			if l.junction(src, dst) != nil {
				warn = append(warn, name)
			}
			continue
		}
		if copySharedFile(src, dst) != nil {
			warn = append(warn, name)
		}
	}
	return warn
}

func copySharedFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return platform.WriteFileAtomic(dst, b, fileMode)
}

// alive 는 pid 가 살아 있는가다.
func (s *Service) alive(pid int) bool {
	if s.Alive != nil {
		return s.Alive(pid)
	}
	return platform.Current().Process.Alive(pid)
}

// PinnedRunning 은 프로필로 실행 중인 claude 가 있는가다 — `sessions/<pid>.json` 의 pid 가 살아
// 있다 (FR-CAC-87).
func (s *Service) PinnedRunning(id string) bool {
	files, _ := filepath.Glob(filepath.Join(s.ProfileDir(id), sessionsDir, "*.json"))
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var v struct {
			PID int `json:"pid"`
		}
		if json.Unmarshal(b, &v) == nil && v.PID > 0 && s.alive(v.PID) {
			return true
		}
	}
	return false
}

// ReclaimProfile 은 프로필의 토큰이 같은 계정이고 백업보다 새것이면 백업에 쓴다 (FR-CAC-86).
// 프로필에서 돈 토큰을 회수하지 않으면 백업의 갱신 토큰은 쓸 수 없게 된다.
func (s *Service) ReclaimProfile(a Account) {
	dir := s.ProfileDir(a.ID)
	if _, err := os.Stat(dir); err != nil {
		return
	}
	oa, ok, err := ReadOAuthAccount(ProfileClaudePaths(dir).GlobalConfig)
	if err != nil || !ok || oa.EmailAddress != a.Email || oa.OrganizationUUID != a.OrgUUID {
		return
	}
	pc, ok, err := s.ProfileLive(a.ID).Read()
	if err != nil || !ok || pc.IsEmpty() {
		return
	}
	unlock, err := platform.LockFile(s.consumeLock(a.ID), s.lockTimeout())
	if err != nil {
		return
	}
	defer unlock()
	bc, ok, err := s.Backup.Read(a.ID)
	if err != nil || (ok && pc.ExpiresAt() <= bc.ExpiresAt()) {
		return
	}
	if err := s.Backup.Write(a.ID, pc); err != nil {
		dmlog.Infof(nil, "claude-accounts: 프로필 토큰을 회수하지 못했다: %v", err)
	}
}

// consumeLock 은 계정 백업을 갱신할 때 잡는 락이다 (FR-CAC-43).
func (s *Service) consumeLock(id string) string {
	return filepath.Join(s.Dir, "credentials", ".consume-"+id+".lock")
}

// removeProfile 은 프로필 폴더와 프로필 키체인 항목을 지운다 (FR-CAC-12).
func (s *Service) removeProfile(id string) error {
	dir := s.ProfileDir(id)
	paths := ProfileClaudePaths(dir)
	if s.Live.Sec != nil && s.Live.Sec.Available() {
		_ = s.Live.Sec.Delete(paths.KeychainService, s.Live.Sec.Account())
	}
	_ = os.RemoveAll(dir + ".lock")
	return os.RemoveAll(dir)
}

func (s *Service) setProfileWarnings(id string, warn []string) {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	if len(warn) == 0 {
		delete(s.warns, id)
		return
	}
	if s.warns == nil {
		s.warns = map[string][]string{}
	}
	s.warns[id] = append([]string(nil), warn...)
}

// ProfileWarnings 는 그 계정의 마지막 프로필 준비에서 잇지 못한 공유 항목이다 (FR-CAC-88b).
func (s *Service) ProfileWarnings(id string) []string {
	s.wmu.Lock()
	defer s.wmu.Unlock()
	return append([]string(nil), s.warns[id]...)
}
