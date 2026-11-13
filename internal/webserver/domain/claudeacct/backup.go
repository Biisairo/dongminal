package claudeacct

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"

	"dongminal/internal/shared/platform"
)

// backupService 는 dongminal 이 계정 백업을 두는 키체인 서비스다 (FR-CAC-4).
const backupService = "dongminal-claude-accounts"

var (
	idRe         = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	ErrInvalidID = errors.New("계정 ID 형식이 틀렸습니다")
)

// BackupStore 는 계정별 자격증명 백업이다. 파일이 있으면 파일이 이긴다 — 키체인 쓰기가
// 실패했을 때만 파일이 생기기 때문이다.
type BackupStore struct {
	Dir string
	Sec platform.Secrets
}

func (b BackupStore) file(id, suffix string) string {
	return filepath.Join(b.Dir, "credentials", id+suffix+".json")
}

func kcAccount(id, suffix string) string { return "account-" + id + suffix }

func (b BackupStore) read(id, suffix string) (Credential, bool, error) {
	if !idRe.MatchString(id) {
		return Credential{}, false, ErrInvalidID
	}
	if raw, err := os.ReadFile(b.file(id, suffix)); err == nil {
		c, err := ParseCredential(raw)
		return c, err == nil, err
	} else if !errors.Is(err, os.ErrNotExist) {
		return Credential{}, false, err
	}
	if !b.Sec.Available() {
		return Credential{}, false, nil
	}
	v, ok, err := b.Sec.Get(backupService, kcAccount(id, suffix))
	if err != nil || !ok {
		return Credential{}, false, err
	}
	c, err := ParseCredential([]byte(v))
	return c, err == nil, err
}

func (b BackupStore) write(id, suffix string, c Credential) error {
	raw, err := c.Marshal()
	if err != nil {
		return err
	}
	if b.Sec.Available() {
		if err := b.Sec.Set(backupService, kcAccount(id, suffix), string(raw)); err == nil {
			if err := os.Remove(b.file(id, suffix)); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			return nil
		}
	}
	if err := writeSecretFile(b.file(id, suffix), raw); err != nil {
		return err
	}
	return b.Sec.Delete(backupService, kcAccount(id, suffix))
}

// Read 는 계정의 백업이다.
func (b BackupStore) Read(id string) (Credential, bool, error) { return b.read(id, "") }

// ReadPrev 는 바로 앞 세대의 백업이다.
func (b BackupStore) ReadPrev(id string) (Credential, bool, error) { return b.read(id, ".prev") }

// Write 는 지금 백업을 앞 세대로 남기고 새 백업을 쓴다.
func (b BackupStore) Write(id string, c Credential) error {
	if !idRe.MatchString(id) {
		return ErrInvalidID
	}
	if cur, ok, err := b.Read(id); err == nil && ok {
		if err := b.write(id, ".prev", cur); err != nil {
			return err
		}
	}
	return b.write(id, "", c)
}

// Delete 는 백업과 앞 세대를 모두 지운다.
func (b BackupStore) Delete(id string) error {
	if !idRe.MatchString(id) {
		return ErrInvalidID
	}
	var errs []error
	for _, sfx := range []string{"", ".prev"} {
		if err := os.Remove(b.file(id, sfx)); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
		if err := b.Sec.Delete(backupService, kcAccount(id, sfx)); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func dirOf(p string) string { return filepath.Dir(p) }
