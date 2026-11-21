package hub

import (
	"context"
	"path/filepath"
	"strings"
	"time"
)

// 계기 관측 — 감시 이벤트가 저장소 관측을 당긴다 (EDITOR_LIVE_RELOAD_SRS FR-ELR-75).

// gitKick 은 저장소 하나의 계기 관측 상태다 (FR-ELR-75).
type gitKick struct {
	debounce func() bool
	running  bool
	cooling  bool
	again    bool
}

const (
	// GitKickDebounce·GitKickCooldown 은 감시 이벤트가 저장소 관측을 당기는 규칙이다
	// (VS Code `extensions/git/src/repository.ts` — `@debounce(1000)` 과 `status()` 뒤 `timeout(5000)`).
	GitKickDebounce = 1000 * time.Millisecond
	GitKickCooldown = 5000 * time.Millisecond
)

// Kick 은 감시 이벤트의 경로들을 받아, 그 경로를 품는 감시 중 저장소를 곧바로 관측하게
// 한다 (FR-ELR-75). `.git/` 아래 경로는 계기가 아니다 — signature 회차가 이미 본다.
func (w *GitWatcher) Kick(paths []string) {
	if w == nil {
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	sep := string(filepath.Separator)
	for repo := range w.watch {
		prefix := strings.TrimSuffix(repo, sep) + sep
		dotGit := prefix + ".git"
		for _, p := range paths {
			if !strings.HasPrefix(p, prefix) || p == dotGit || strings.HasPrefix(p, dotGit+sep) {
				continue
			}
			w.kickLocked(repo)
			break
		}
	}
}

func (w *GitWatcher) kickLocked(repo string) {
	if w.kicks == nil {
		w.kicks = map[string]*gitKick{}
	}
	k := w.kicks[repo]
	if k == nil {
		k = &gitKick{}
		w.kicks[repo] = k
	}
	if k.debounce != nil {
		k.debounce()
	}
	k.debounce = w.afterFunc(GitKickDebounce, func() { w.kickFire(repo) })
}

func (w *GitWatcher) afterFunc(d time.Duration, f func()) func() bool {
	if w.after != nil {
		return w.after(d, f)
	}
	return time.AfterFunc(d, f).Stop
}

// kickFire 는 debounce 가 끝난 순간이다. 관측 중이거나 쉬는 중이면 한 번으로 모은다.
func (w *GitWatcher) kickFire(repo string) {
	w.mu.Lock()
	k := w.kicks[repo]
	if k == nil {
		w.mu.Unlock()
		return
	}
	k.debounce = nil
	if k.running || k.cooling {
		k.again = true
		w.mu.Unlock()
		return
	}
	k.running = true
	w.mu.Unlock()
	w.kickRun(repo)
}

func (w *GitWatcher) kickRun(repo string) {
	w.mu.Lock()
	root := w.root
	w.mu.Unlock()
	if root == nil {
		root = context.Background()
	}
	ctx, cancel := context.WithTimeout(root, GitWatchRoundTimeout)
	w.observe(ctx, repo, 0, true)
	cancel()
	w.mu.Lock()
	defer w.mu.Unlock()
	k := w.kicks[repo]
	if k == nil {
		return
	}
	k.running, k.cooling = false, true
	w.afterFunc(GitKickCooldown, func() { w.kickCool(repo) })
}

func (w *GitWatcher) kickCool(repo string) {
	w.mu.Lock()
	k := w.kicks[repo]
	if k == nil {
		w.mu.Unlock()
		return
	}
	k.cooling = false
	if !k.again {
		if k.debounce == nil {
			delete(w.kicks, repo)
		}
		w.mu.Unlock()
		return
	}
	k.again, k.running = false, true
	w.mu.Unlock()
	w.kickRun(repo)
}
