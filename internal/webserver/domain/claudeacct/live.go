package claudeacct

import (
	"errors"
	"fmt"
	"os"
	"time"

	"dongminal/internal/shared/platform"
)

const (
	fileMode       = 0o600
	dirMode        = 0o700
	liveReadTries  = 2
	liveRetryDelay = 300 * time.Millisecond
)

// ErrKeychainUnavailable 은 키체인을 읽을 수 없고 대신할 파일도 없다는 뜻이다.
var ErrKeychainUnavailable = errors.New("키체인을 읽을 수 없습니다")

// LiveStore 는 Claude Code 가 읽는 자격증명 저장소다 (FR-CAC-4~6).
type LiveStore struct {
	Paths      ClaudePaths
	Sec        platform.Secrets
	RetryDelay time.Duration
}

// Read 는 ① 키체인 ② `.credentials.json` 순으로 읽는다. 둘 다 없으면 (_, false, nil) 이다.
func (l LiveStore) Read() (Credential, bool, error) {
	var kcErr error
	if l.Sec.Available() {
		for i := 0; i < liveReadTries; i++ {
			v, ok, err := l.Sec.Get(l.Paths.KeychainService, l.Sec.Account())
			if err == nil && ok {
				c, perr := ParseCredential([]byte(v))
				if perr != nil {
					return Credential{}, false, perr
				}
				return c, true, nil
			}
			if err == nil {
				kcErr = nil
				break
			}
			kcErr = err
			if i+1 < liveReadTries {
				time.Sleep(l.retryDelay())
			}
		}
	}
	b, err := os.ReadFile(l.Paths.Credentials)
	if errors.Is(err, os.ErrNotExist) {
		if kcErr != nil {
			return Credential{}, false, fmt.Errorf("%w: %v", ErrKeychainUnavailable, kcErr)
		}
		return Credential{}, false, nil
	}
	if err != nil {
		return Credential{}, false, err
	}
	c, err := ParseCredential(b)
	if err != nil {
		return Credential{}, false, err
	}
	return c, true, nil
}

func (l LiveStore) retryDelay() time.Duration {
	if l.RetryDelay > 0 {
		return l.RetryDelay
	}
	return liveRetryDelay
}

// Write 는 키체인에 쓰고, `.credentials.json` 이 이미 있으면 같은 바이트로 다시 써서
// 실행 중인 세션이 다시 읽게 한다. 키체인 쓰기가 실패하면 파일에 쓰고 키체인 항목을
// 지운다 (FR-CAC-6).
func (l LiveStore) Write(c Credential) error {
	b, err := c.Marshal()
	if err != nil {
		return err
	}
	if l.Sec.Available() {
		if err := l.Sec.Set(l.Paths.KeychainService, l.Sec.Account(), string(b)); err == nil {
			if _, err := os.Stat(l.Paths.Credentials); err == nil {
				return platform.WriteFileAtomic(l.Paths.Credentials, b, fileMode)
			}
			return nil
		}
		if err := writeSecretFile(l.Paths.Credentials, b); err != nil {
			return err
		}
		return l.Sec.Delete(l.Paths.KeychainService, l.Sec.Account())
	}
	return writeSecretFile(l.Paths.Credentials, b)
}

// writeSecretFile 은 0700 폴더 안에 0600 파일을 원자적으로 쓴다 (FR-CAC-1·2).
func writeSecretFile(path string, b []byte) error {
	if err := os.MkdirAll(dirOf(path), dirMode); err != nil {
		return err
	}
	return platform.WriteFileAtomic(path, b, fileMode)
}
