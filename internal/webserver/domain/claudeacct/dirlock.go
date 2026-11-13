package claudeacct

import (
	"errors"
	"math/rand/v2"
	"os"
	"time"
)

// Claude Code 의 npm proper-lockfile 과 호환되는 디렉터리 락 (FR-CAC-30 ②, cswap
// `claude_locks.py`). mkdir 의 원자성이 상호 배제이고, 잡은 쪽은 mtime 을 주기적으로
// 갱신한다. mtime 이 staleness 보다 오래된 락은 버려진 것으로 보고 가져온다.
const (
	credLockStale     = 60 * time.Second
	configLockStale   = 10 * time.Second
	takeoverStale     = 5 * time.Second
	takeoverSuffix    = ".takeover"
	DefaultLockWait   = 9 * time.Second
	dirLockPollMin    = 250 * time.Millisecond
	dirLockPollJitter = 250 * time.Millisecond
)

// dirLockTouch 는 잡은 동안 mtime 을 갱신하는 주기다. 시험이 줄인다.
var dirLockTouch = 3 * time.Second

// ErrClaudeLockTimeout 은 Claude Code 가 자격증명이나 설정을 쓰는 중이라 기다리다 그만뒀다는 뜻이다.
var ErrClaudeLockTimeout = errors.New("Claude Code 가 자격증명을 갱신하는 중입니다. 잠시 뒤 다시 시도하세요")

func acquireDirLock(dir string, staleness, timeout time.Duration) (func(), error) {
	if err := os.MkdirAll(dirOf(dir), dirMode); err != nil {
		return nil, err
	}
	start := time.Now()
	for {
		err := os.Mkdir(dir, dirMode)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if time.Since(start) > timeout {
			return nil, ErrClaudeLockTimeout
		}
		st, err := os.Stat(dir)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err == nil && time.Since(st.ModTime()) > staleness {
			if !removeIfStillStale(dir, staleness) {
				time.Sleep(50 * time.Millisecond)
			}
			continue
		}
		time.Sleep(dirLockPollMin + time.Duration(rand.Int64N(int64(dirLockPollJitter))))
	}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		t := time.NewTicker(dirLockTouch)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				now := time.Now()
				if os.Chtimes(dir, now, now) != nil {
					return
				}
			}
		}
	}()
	return func() {
		close(stop)
		<-done
		_ = os.Remove(dir)
	}, nil
}

// removeIfStillStale 은 takeover 디렉터리 아래에서 낡은 락을 지운다. 두 대기자가 동시에
// 지우다 새 주인의 락을 지우는 일을 막는다.
func removeIfStillStale(dir string, staleness time.Duration) bool {
	tk := dir + takeoverSuffix
	if err := os.Mkdir(tk, dirMode); err != nil {
		if st, serr := os.Stat(tk); serr == nil && time.Since(st.ModTime()) > takeoverStale {
			_ = os.Remove(tk)
		}
		return false
	}
	defer os.Remove(tk)
	st, err := os.Stat(dir)
	if err != nil || time.Since(st.ModTime()) <= staleness {
		return false
	}
	return os.Remove(dir) == nil
}

// lockClaude 는 Claude Code 의 자격증명 락 둘과 설정 락을 이 순서로 잡는다.
func lockClaude(p ClaudePaths, timeout time.Duration) (func(), error) {
	var rels []func()
	release := func() {
		for i := len(rels) - 1; i >= 0; i-- {
			rels[i]()
		}
	}
	for _, d := range p.CredLockDirs() {
		r, err := acquireDirLock(d, credLockStale, timeout)
		if err != nil {
			release()
			return nil, err
		}
		rels = append(rels, r)
	}
	r, err := acquireDirLock(p.ConfigLockDir(), configLockStale, timeout)
	if err != nil {
		release()
		return nil, err
	}
	rels = append(rels, r)
	return release, nil
}
