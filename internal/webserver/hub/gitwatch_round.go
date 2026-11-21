package hub

import (
	"context"
	"sync/atomic"
	"time"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/fanout"
	"dongminal/internal/webserver/domain/git/core"
)

// 감시 회차 — 1차 게이트(signature)와 2차 관측(status), 탈락·백오프 (FR-GDT-1~10).

// SetWorktreeEvery 는 워크트리 회차의 간격을 바꾼다. 다음 회차부터 적용된다 (FR-ELR-76).
// 0 은 기본값(`GitWatchWorktreeEvery`)이다.
func (w *GitWatcher) SetWorktreeEvery(n uint64) {
	if w == nil {
		return
	}
	w.worktreeEvery.Store(n)
}

func (w *GitWatcher) worktreeRounds() uint64 {
	if n := w.worktreeEvery.Load(); n > 0 {
		return n
	}
	return GitWatchWorktreeEvery
}

/*
Tick 은 회차 하나다 (FR-GPO-3).

감시 대상 각각의 signature 를 읽고 **직전 값과 다를 때만** 방송한다. 같으면
아무것도 하지 않는다 — `SetForegroundNotifier` 가 "값이 바뀌었을 때만 부른다"
(FR-TAN-9)로 세운 계약과 같다.

첫 회차는 방송하지 않는다. 그때의 signature 는 "바뀐 것" 이 아니라 기준선이며,
브라우저는 방금 status 를 받아 그 값을 이미 알고 있다.

결정적 읽기 오류(core.IsTerminal)만 그 저장소를 대상에서 뺀다 (FR-GPO-5, REPO_FIX
02 §3A-1). 저장소가 사라졌거나 저장소가 아닌 것이고, 그 판정과 화면 처리는
브라우저의 `GIT_REPO_MISSING` 경로가 이미 갖고 있다 (FR-RMS-6) — 감시자는 mark:""
로 한 번 알릴 뿐 그것을 흉내내지 않는다. 일시적 오류는 백오프한다.
*/
func (w *GitWatcher) Tick(ctx context.Context) int {
	if w == nil || w.git == nil {
		return 0
	}
	w.mu.Lock()
	now := w.now()
	w.evictLocked(now)
	round := w.round
	w.round++
	repos := make([]string, 0, len(w.watch))
	for repo := range w.watch {
		repos = append(repos, repo)
	}
	w.mu.Unlock()

	/*
		GIT_DETECT_TIER_SRS FR-GDT-8 (`11 GP-8` · `GO-33`): **회차를 병렬로 돈다.**

		  이전 동작: 한 고루틴에서 차례로 관측했다. 저장소 하나가 3초 걸리면 그
		            회차 전체가 3초 이상이고, `time.Ticker` 는 밀린 틱을 버리므로
		            **다른 저장소의 감지가 함께 늦어졌다**
		  새  동작: `gitObservePins` 와 같은 상한 병렬(fanout.Each)로 묶는다
		  이유:     같은 문제를 아는 자리가 이미 있었는데 감시 회차만 순차였다

		상한을 두는 이유도 그쪽과 같다 — 대상이 늘어도 git 프로세스가 대상 수만큼
		한꺼번에 뜨지 않게 한다.
	*/
	// 회차의 시한이 끝나면 남은 저장소를 시작하지 않는다 (FR-GDT-9, fanout.Each).
	var sent atomic.Int64
	fanout.Each(ctx, GitWatchParallel, len(repos), func(i int) {
		if w.observe(ctx, repos[i], round, false) {
			sent.Add(1)
		}
	})
	return int(sent.Load())
}

/*
observe 는 저장소 하나의 회차다. 방송했으면 참이다.

**2단이다** (FR-GDT-1·2). 1차는 `ReadSignature` — git 을 실행하지 않는다. 2차는
`git status` 이고, 그것을 돌리는 회차는 넷 중 하나다:

	① signature 가 확정된 값(lastSig)과 다르다
	② 변화 이후의 관측을 기다리는 중이다(pending)
	③ 이 저장소의 워크트리 회차다 (저빈도)
	④ signature 를 읽지 못했다(일시적) — 판정할 수 없으면 관측한다

	이전 동작: 회차마다 `git status` 를 돌렸다. 아무 변화가 없어도 1초마다,
	          최대 16개 저장소 동시에, 브라우저가 숨어도 90초 동안
	새  동작: 변화가 없으면 1차 게이트에서 끝난다
	이유:     `GIT_PUSH_OBSERVE_SRS §1.2` 가 fsnotify 를 기각하며 든 근거가
	          **"ReadSignature = 0.02ms 이므로 싸다"** 였는데, 구현이 그 자리에서
	          `git status` 를 돌려 그 근거를 스스로 무효로 만들었다 (`11 GP-7`)

REPO_FIX 02 §3A-1 — 감시 수명:

	이전 동작: 오류 종류를 가리지 않고 감시에서 뺐고(취소·시한도), lastSig 를 관측
	          **전에** 전진시켜 실패한 회차의 변화를 잃었다
	새  동작: 결정적 오류(core.IsTerminal)만 빼고 mark:"" 를 1회 알린다. 일시적 오류는
	          기준선·임대를 그대로 두고 백오프한다. signature 가 바뀌면 Invalidate 뒤
	          관측하고, 관측이 성립한 뒤에만 lastSig 를 확정한다
	이유:     한 요청의 취소·잠깐 깨진 index 가 감시를 영구히 걷었고(#20), 회차 시한
	          (20s)보다 느린 status 의 변화가 방송되지 않았다(N5)
*/
func (w *GitWatcher) observe(ctx context.Context, repo string, round uint64, force bool) bool {
	w.mu.Lock()
	e, ok := w.watch[repo]
	if !ok || w.now().Before(e.retryAt) {
		w.mu.Unlock()
		return false
	}
	w.mu.Unlock()

	sig, sigErr := w.git.Signature(ctx, repo)
	if core.IsTerminal(sigErr) {
		return w.drop(repo, sigErr)
	}

	w.mu.Lock()
	e, ok = w.watch[repo]
	if !ok { // 회차 중에 만료·퇴출됐다
		w.mu.Unlock()
		return false
	}
	// FR-GDT-4 / D-GDT-2: 워크트리 회차를 저장소마다 **어긋나게** 돈다.
	worktreeRound := (round+e.phase)%w.worktreeRounds() == 0
	invalidate := false
	if sigErr == nil && (!e.hasSig || e.lastSig != sig.Value) {
		// 새 변화다. 기다리던 것과 같은 값이면 이미 무효화했다 — 합류만 한다.
		if !e.pending || e.pendingSig != sig.Value {
			invalidate = true
			e.pending, e.pendingSig, e.pendingAt = true, sig.Value, w.now()
		}
	}
	pending, pendingAt := e.pending, e.pendingAt
	need := pending || worktreeRound || sigErr != nil || force
	invalidate = invalidate || force
	w.mu.Unlock()

	// FR-GDT-7: 2차를 건너뛴 회차는 **방송하지 않는다.**
	if !need {
		return false
	}
	if invalidate {
		w.git.Invalidate(repo)
	}

	obs, _, err := w.git.Status(ctx, repo)
	if err != nil && pending {
		// 회차 시한이 놓친 관측을 flight 가 끝내 Store 에 남겼을 수 있다. 변화 이후에
		// 끝난 관측이면 그것으로 성립한다 (01 은 옛 세대 결과를 유효로 두지 않는다).
		if last, ok := w.git.Observed(repo); ok && last.ObservedAtUnixMs >= pendingAt.UnixMilli() {
			obs, err = last, nil
		}
	}
	if err != nil {
		if core.IsTerminal(err) {
			return w.drop(repo, err)
		}
		w.fail(repo, err, pending && ctx.Err() != nil)
		return false
	}

	mark := obsMark(obs)
	w.mu.Lock()
	e, ok = w.watch[repo]
	if !ok {
		w.mu.Unlock()
		return false
	}
	e.fails, e.retryAt = 0, time.Time{}
	if pending && e.pending && e.pendingSig != "" {
		e.lastSig, e.hasSig = e.pendingSig, true
		e.pending = false
	}
	first := !e.hasMark
	changed := e.hasMark && e.lastMark != mark
	e.lastMark, e.hasMark = mark, true
	w.mu.Unlock()

	if first || !changed {
		return false
	}
	w.announce(repo, mark)
	return true
}

// drop 은 결정적 오류(저장소 소실·비저장소·git 부재)의 저장소를 감시에서 빼고
// `git_changed`(mark:"")를 한 번 알린다 — 브라우저가 status 를 다시 물어
// `GIT_REPO_MISSING` 화면으로 간다 (FR-RMS-6).
func (w *GitWatcher) drop(repo string, err error) bool {
	w.mu.Lock()
	_, ok := w.watch[repo]
	delete(w.watch, repo)
	w.mu.Unlock()
	if !ok {
		return false
	}
	// FR-GLW-7: 탈락은 **저장소가 읽히지 않은 것**이다 (FR-GPO-5).
	dmlog.Errorf(nil, "[gitwatch] 저장소를 읽을 수 없어 감시에서 뺀다 (repo=%s err=%v)", repo, err)
	w.git.ForgetRoot(repo)
	w.announce(repo, "")
	return true
}

// fail 은 일시적 관측 실패다. 기준선(lastSig·lastMark)·임대·pending 을 그대로 두고,
// 연속 실패 n 에 따라 min(2^(n-1), 30)s 동안 그 저장소를 건너뛴다. 회차 시한이 놓친
// 관측(pending 중)은 flight 가 계속 돌므로 n 을 올리지 않는다.
func (w *GitWatcher) fail(repo string, err error, roundTimeout bool) {
	if roundTimeout {
		return
	}
	w.mu.Lock()
	e, ok := w.watch[repo]
	if !ok {
		w.mu.Unlock()
		return
	}
	e.fails++
	n := e.fails
	wait := GitWatchBackoffMax
	if n <= 5 {
		wait = time.Duration(1<<(n-1)) * time.Second
	}
	e.retryAt = w.now().Add(wait)
	w.mu.Unlock()
	if n == 1 || n%10 == 0 {
		dmlog.Infof(nil, "[gitwatch] 관측 실패 — 감시는 유지하고 %v 뒤 다시 본다 (repo=%s n=%d err=%v)", wait, repo, n, err)
	}
}
