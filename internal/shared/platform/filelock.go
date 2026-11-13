package platform

import (
	"errors"
	"os"
	"path/filepath"
	"time"
)

// ErrLockTimeout 은 LockFile 이 기다림 한도 안에 락을 잡지 못했다는 뜻이다.
var ErrLockTimeout = errors.New("락을 잡지 못했습니다")

const lockRetry = 100 * time.Millisecond

// LockFile 은 path 에 배타 락을 잡는다 (CLAUDE_ACCOUNTS_SRS FR-CAC-3). 잡을 수 없으면
// 0.1초 간격으로 다시 시도하고, timeout 이 지나면 ErrLockTimeout 이다. 재진입하지 않는다.
// 돌려준 함수가 락을 놓는다.
func LockFile(path string, timeout time.Duration) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, err
	}
	deadline := time.Now().Add(timeout)
	for {
		ok, err := tryLock(f)
		if err != nil {
			f.Close()
			return nil, err
		}
		if ok {
			return func() {
				unlock(f)
				f.Close()
			}, nil
		}
		if time.Now().After(deadline) {
			f.Close()
			return nil, ErrLockTimeout
		}
		time.Sleep(lockRetry)
	}
}
