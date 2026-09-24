package gitapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/webserver/apierr"
	"dongminal/internal/webserver/domain/git/core"
	"dongminal/internal/webserver/domain/git/jobs"
)

// REPO_FIX 01 §5.4·5.5·7.1·7.2 — 배타 행렬, 잠금 대기, 단계별 ctx, index.lock.
//
// 진행 중인 동기 쓰기는 배타 상태의 toplevel 뮤텍스를 직접 쥐어 흉내 낸다 — 쓰기를
// 실제로 매달면 "무엇이 막았는가" 가 fake 의 타이밍에 달린다.

const exclTestWait = 80 * time.Millisecond

// exclServer 는 짧은 잠금 대기와 매달리는 잡 실행기를 가진 서버다.
func exclServer(t *testing.T, f *gitWriteFake) (*GitServer, chan struct{}) {
	t.Helper()
	s, _ := gitWriteServer(t, f)
	s.Exclusion = jobs.NewExclusion()
	s.lockWait = exclTestWait
	release := make(chan struct{})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	s.gitJobs.run = gitRemoteHold(release)
	return s, release
}

// exclKeys 는 fake 가 답하는 저장소의 배타 키다 — fake 는 toplevel 로 요청 dir,
// common-dir 로 gitDir 을 준다.
func exclKeys(f *gitWriteFake) jobs.Keys {
	return jobs.Keys{Top: core.ExclusionKey(gitWriteRepo), Common: core.ExclusionKey(f.gitDir)}
}

func exclWrites(f *gitWriteFake, sub string) int {
	n := 0
	for _, a := range f.wrote() {
		if len(a) > 0 && a[0] == sub {
			n++
		}
	}
	return n
}

var exclStageBody = `{"repo":` + qWorkRepo + `,"paths":["a.txt"]}`

// 행렬 1행: 아무것도 없으면 셋 다 실행된다.
func TestExclusionMatrix_Idle(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", exclStageBody); code != http.StatusOK {
		t.Fatalf("동기 쓰기 code = %d, %v", code, out)
	}
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/pull", `{"repo":`+qWorkRepo+`}`); code != http.StatusOK {
		t.Fatalf("index 잡 code = %d, %v", code, out)
	}
}

// 행렬 2행: 같은 toplevel 의 동기 쓰기가 뮤텍스를 쥐고 있다 — 동기 쓰기·index 잡은
// 상한까지 기다린 뒤 409 repo_busy, 비-index 잡은 실행.
func TestExclusionMatrix_SyncWriteHeld(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	release, err := s.Exclusion.LockTop(context.Background(), exclKeys(f).Top, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()

	started := time.Now()
	code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", exclStageBody)
	if code != http.StatusConflict || out["error"] != apierr.CodeRepoBusy {
		t.Fatalf("동기 쓰기 = %d %v, want 409 repo_busy", code, out)
	}
	if el := time.Since(started); el < exclTestWait {
		t.Fatalf("잠금 상한 %v 을 기다리지 않았다 (%v)", exclTestWait, el)
	}
	if n := exclWrites(f, "add"); n != 0 {
		t.Fatalf("막힌 쓰기가 실행됐다 (add %d회)", n)
	}
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/pull", `{"repo":`+qWorkRepo+`}`); code != http.StatusConflict || out["error"] != apierr.CodeRepoBusy {
		t.Fatalf("index 잡 = %d %v, want 409 repo_busy", code, out)
	}
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/fetch", `{"repo":`+qWorkRepo+`}`); code != http.StatusOK {
		t.Fatalf("비-index 잡 = %d %v, want 200", code, out)
	}
}

// 행렬 3행: index 잡(pull)이 돈다 — 동기 쓰기는 **즉시** job_busy, index 잡도
// job_busy, 비-index 잡은 pull 이 common 칸도 쥐므로 job_busy.
func TestExclusionMatrix_IndexJobRunning(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/pull", `{"repo":`+qWorkRepo+`}`); code != http.StatusOK {
		t.Fatalf("pull 시작 = %d %v", code, out)
	}
	started := time.Now()
	code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", exclStageBody)
	if code != http.StatusConflict || out["error"] != apierr.CodeJobBusy {
		t.Fatalf("동기 쓰기 = %d %v, want 409 job_busy", code, out)
	}
	if el := time.Since(started); el >= exclTestWait {
		t.Fatalf("job_busy 가 잠금 대기를 거쳤다 (%v) — 즉시여야 한다", el)
	}
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/pull", `{"repo":`+qWorkRepo+`}`); code != http.StatusConflict || out["error"] != apierr.CodeJobBusy {
		t.Fatalf("index 잡 = %d %v, want 409 job_busy", code, out)
	}
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/fetch", `{"repo":`+qWorkRepo+`}`); code != http.StatusConflict || out["error"] != apierr.CodeJobBusy {
		t.Fatalf("pull 중 fetch = %d %v, want 409 job_busy (두 칸)", code, out)
	}
}

// 행렬 4행: 비-index 잡(fetch)이 돈다 — 동기 쓰기·index 잡 중 pull 은 예외(common
// 칸), 동기 쓰기는 실행, 비-index 잡은 job_busy.
func TestExclusionMatrix_CommonJobRunning(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/fetch", `{"repo":`+qWorkRepo+`}`); code != http.StatusOK {
		t.Fatalf("fetch 시작 = %d %v", code, out)
	}
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", exclStageBody); code != http.StatusOK {
		t.Fatalf("fetch 중 동기 쓰기 = %d %v, want 200", code, out)
	}
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/pull", `{"repo":`+qWorkRepo+`}`); code != http.StatusConflict || out["error"] != apierr.CodeJobBusy {
		t.Fatalf("fetch 중 pull = %d %v, want 409 job_busy", code, out)
	}
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/fetch", `{"repo":`+qWorkRepo+`}`); code != http.StatusConflict || out["error"] != apierr.CodeJobBusy {
		t.Fatalf("fetch 중 fetch = %d %v, want 409 job_busy", code, out)
	}
}

// 잠금 대기 중 요청이 떠나면 실행하지 않는다.
func TestExclusion_CanceledWhileWaitingNotExecuted(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	s.lockWait = time.Second
	release, err := s.Exclusion.LockTop(context.Background(), exclKeys(f).Top, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest(http.MethodPost, "/api/git/stage", strings.NewReader(exclStageBody)).WithContext(ctx)
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		s.handler().ServeHTTP(rec, r)
		close(done)
	}()
	time.Sleep(exclTestWait / 2)
	cancel()
	<-done
	release()
	if code, name := decodeFail(t, rec); code != apierr.StatusClientClosed || name != apierr.CodeCanceled {
		t.Fatalf("대기 중 취소 = %d %s, want %d git_canceled", code, name, apierr.StatusClientClosed)
	}
	if n := exclWrites(f, "add"); n != 0 {
		t.Fatalf("떠난 요청의 쓰기가 실행됐다 (add %d회)", n)
	}
}

// §5.3·5.4: stash 는 common-dir 잠금을 먼저 쥔다 — 같은 common dir 의 다른
// worktree 가 stash 중이면 repo_busy.
func TestExclusion_StashTakesCommonDirLock(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	release, err := s.Exclusion.LockCommon(context.Background(), exclKeys(f).Common, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	code, out := gitReq(t, s, http.MethodPost, "/api/git/stash/push", `{"repo":`+qWorkRepo+`}`)
	if code != http.StatusConflict || out["error"] != apierr.CodeRepoBusy {
		t.Fatalf("stash push = %d %v, want 409 repo_busy", code, out)
	}
	// 동기 쓰기(stage)는 common-dir 잠금을 보지 않는다.
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", exclStageBody); code != http.StatusOK {
		t.Fatalf("stage = %d %v, want 200", code, out)
	}
}

// §5.5: 쓰기 단계는 서버 루트 ctx 에서 파생한다 — 쓰기가 시작된 뒤 요청이 떠나도
// 쓰기와 사후 단계는 끝까지 간다.
func TestExclusion_WritePhaseIgnoresRequestCancel(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	var writeCtxErr error
	var once sync.Once
	f.writeCtx = func(wctx context.Context) {
		once.Do(func() {
			cancel()
			writeCtxErr = wctx.Err()
		})
	}
	r := httptest.NewRequest(http.MethodPost, "/api/git/stage", strings.NewReader(exclStageBody)).WithContext(ctx)
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, r)
	if writeCtxErr != nil {
		t.Fatalf("요청 취소가 쓰기 ctx 로 번졌다: %v", writeCtxErr)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("쓰기 뒤 이탈 = %d %s, want 200 (사후 단계까지 끝낸다)", rec.Code, rec.Body.String())
	}
}

// §5.5 ④: 사전 단계 뒤·쓰기 직전에 요청이 떠났으면 실행하지 않는다.
func TestExclusion_CanceledBeforeWriteNotExecuted(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	f.onStatus = func() { cancel() }
	r := httptest.NewRequest(http.MethodPost, "/api/git/stage", strings.NewReader(exclStageBody)).WithContext(ctx)
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, r)
	if n := exclWrites(f, "add"); n != 0 {
		t.Fatalf("쓰기 직전에 떠난 요청이 실행됐다 (add %d회)", n)
	}
	if code, name := decodeFail(t, rec); code != apierr.StatusClientClosed || name != apierr.CodeCanceled {
		t.Fatalf("= %d %s, want 499 git_canceled", code, name)
	}
}

// 잠금은 응답 뒤 반납된다 — 다음 쓰기가 기다리지 않는다.
func TestExclusion_ReleasedAfterResponse(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	for i := 0; i < 3; i++ {
		if code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", exclStageBody); code != http.StatusOK {
			t.Fatalf("%d번째 = %d %v", i, code, out)
		}
	}
	rel, ok := s.Exclusion.TryLockTop(exclKeys(f).Top)
	if !ok {
		t.Fatal("응답 뒤에도 뮤텍스가 쥐여 있다")
	}
	rel()
}

// §5.2: POST 종단 전부가 잠금 분류표에 있다 — 새 종단이 분류 없이 들어오면 배타가
// 조용히 빠진다.
func TestWriteLocks_CoverAllPostRoutes(t *testing.T) {
	for _, rt := range routes {
		if rt.Method != http.MethodPost {
			continue
		}
		found := false
		for p := range writeLocks {
			if rt.Match(p) {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("POST 종단이 writeLocks 에 없다 — §5.2 분류표에 잠금 열을 정하라")
		}
	}
	for p := range writeLocks {
		matched := false
		for _, rt := range routes {
			if rt.Method == http.MethodPost && rt.Match(p) {
				matched = true
			}
		}
		if !matched {
			t.Errorf("writeLocks 의 %s 가 routes 에 없다", p)
		}
	}
}

// indexLockedErr 는 git 이 index.lock 을 만들지 못한 실패다.
func indexLockedErr(gitDir string) func([]string) (core.Output, error) {
	return func([]string) (core.Output, error) {
		return core.Output{ExitCode: 128, Stderr: "fatal: Unable to create '" + filepath.Join(gitDir, "index.lock") + "': File exists.\n"}, nil
	}
}

// §7.2: 동기 쓰기가 index.lock 에 막히면 409 index_locked 에 lock 경로·mtime 을
// 싣는다.
func TestIndexLocked_SyncWriteCarriesLock(t *testing.T) {
	f := newGitWriteFake(t)
	lock := filepath.Join(f.gitDir, "index.lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Lstat(lock)
	f.writeErr = indexLockedErr(f.gitDir)
	s, _ := exclServer(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", exclStageBody)
	if code != http.StatusConflict || out["error"] != apierr.CodeIndexLocked {
		t.Fatalf("= %d %v, want 409 index_locked", code, out)
	}
	l, _ := out["lock"].(map[string]any)
	if l["path"] != lock {
		t.Fatalf("lock.path = %v, want %s", l["path"], lock)
	}
	if ms, _ := l["mtimeUnixMs"].(float64); int64(ms) != st.ModTime().UnixMilli() {
		t.Fatalf("lock.mtimeUnixMs = %v, want %d", l["mtimeUnixMs"], st.ModTime().UnixMilli())
	}
}

// 파일이 이미 사라졌으면 mtime 을 싣지 않는다 — 프런트는 "다시 시도" 로 안내한다.
func TestIndexLocked_GoneLockOmitsMtime(t *testing.T) {
	f := newGitWriteFake(t)
	f.writeErr = indexLockedErr(f.gitDir)
	s, _ := exclServer(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/stage", exclStageBody)
	if code != http.StatusConflict || out["error"] != apierr.CodeIndexLocked {
		t.Fatalf("= %d %v", code, out)
	}
	l, _ := out["lock"].(map[string]any)
	if l["path"] == nil {
		t.Fatalf("lock.path 가 없다: %v", out)
	}
	if _, has := l["mtimeUnixMs"]; has {
		t.Fatalf("없는 파일의 mtime 을 실었다: %v", l)
	}
}

// §7.2: stash 실패도 같은 판정을 거친다.
func TestIndexLocked_StashCarriesLock(t *testing.T) {
	f := newGitWriteFake(t)
	f.writeErr = indexLockedErr(f.gitDir)
	s, _ := exclServer(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/stash/push", `{"repo":`+qWorkRepo+`}`)
	if code != http.StatusConflict || out["error"] != apierr.CodeIndexLocked || out["lock"] == nil {
		t.Fatalf("= %d %v, want 409 index_locked + lock", code, out)
	}
}

// §7.4: 충돌 해결의 경로 오류에 index_locked 가 있으면 resolve_partial 보다 앞선다.
func TestIndexLocked_ResolvePriority(t *testing.T) {
	f := newGitWriteFake(t)
	locked := indexLockedErr(f.gitDir)
	f.writeErr = func(argv []string) (core.Output, error) {
		if argv[len(argv)-1] == "b.txt" {
			return locked(argv)
		}
		return core.Output{}, nil
	}
	s, _ := exclServer(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/resolve", `{"repo":`+qWorkRepo+`,"side":"ours","paths":["a.txt","b.txt"],"confirm":true}`)
	if code != http.StatusConflict || out["error"] != apierr.CodeIndexLocked {
		t.Fatalf("= %d %v, want 409 index_locked", code, out)
	}
	if out["results"] == nil || out["status"] == nil || out["lock"] == nil {
		t.Fatalf("results·status·lock 이 없다: %v", out)
	}
}

// ── POST /api/git/lock/remove (§7.2) ──

func lockRemoveBody(extra string) string {
	return `{"repo":` + qWorkRepo + extra + `}`
}

func TestLockRemove_RequiresConfirm(t *testing.T) {
	f := newGitWriteFake(t)
	s, _ := exclServer(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/lock/remove", lockRemoveBody(`,"mtimeUnixMs":1`))
	if code != http.StatusBadRequest || out["error"] != apierr.CodeConfirmRequired {
		t.Fatalf("= %d %v, want 400 confirmation_required", code, out)
	}
}

func TestLockRemove_Removes(t *testing.T) {
	f := newGitWriteFake(t)
	lock := filepath.Join(f.gitDir, "index.lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Lstat(lock)
	s, _ := exclServer(t, f)
	body := lockRemoveBody(`,"confirm":true,"mtimeUnixMs":` + strconv.FormatInt(st.ModTime().UnixMilli(), 10))
	code, out := gitReq(t, s, http.MethodPost, "/api/git/lock/remove", body)
	if code != http.StatusOK || out["removed"] != true || out["lockPath"] != lock {
		t.Fatalf("= %d %v, want 200 removed:true", code, out)
	}
	if _, err := os.Lstat(lock); !os.IsNotExist(err) {
		t.Fatalf("lock 이 남았다: %v", err)
	}
	// 이미 없으면 removed:false 로 성공한다.
	code, out = gitReq(t, s, http.MethodPost, "/api/git/lock/remove", body)
	if code != http.StatusOK || out["removed"] != false {
		t.Fatalf("없는 lock = %d %v, want 200 removed:false", code, out)
	}
}

func TestLockRemove_StaleMtime(t *testing.T) {
	f := newGitWriteFake(t)
	lock := filepath.Join(f.gitDir, "index.lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	s, _ := exclServer(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/lock/remove", lockRemoveBody(`,"confirm":true,"mtimeUnixMs":1`))
	if code != http.StatusConflict || out["error"] != apierr.CodeStaleObservation {
		t.Fatalf("= %d %v, want 409 stale_observation", code, out)
	}
	if _, err := os.Lstat(lock); err != nil {
		t.Fatalf("mtime 이 다른데 지웠다: %v", err)
	}
}

func TestLockRemove_NotRegularFile(t *testing.T) {
	f := newGitWriteFake(t)
	lock := filepath.Join(f.gitDir, "index.lock")
	if err := os.Mkdir(lock, 0o755); err != nil {
		t.Fatal(err)
	}
	s, _ := exclServer(t, f)
	code, out := gitReq(t, s, http.MethodPost, "/api/git/lock/remove", lockRemoveBody(`,"confirm":true,"mtimeUnixMs":1`))
	if code != http.StatusBadRequest {
		t.Fatalf("디렉터리 = %d %v, want 400", code, out)
	}
}

func TestLockRemove_BusyAndJob(t *testing.T) {
	f := newGitWriteFake(t)
	lock := filepath.Join(f.gitDir, "index.lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	s, _ := exclServer(t, f)
	body := lockRemoveBody(`,"confirm":true,"mtimeUnixMs":1`)

	// 동기 쓰기가 뮤텍스를 쥐면 기다리지 않고 409 repo_busy.
	release, err := s.Exclusion.LockTop(context.Background(), exclKeys(f).Top, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	code, out := gitReq(t, s, http.MethodPost, "/api/git/lock/remove", body)
	release()
	if code != http.StatusConflict || out["error"] != apierr.CodeRepoBusy {
		t.Fatalf("뮤텍스 사용 중 = %d %v, want 409 repo_busy", code, out)
	}
	if time.Since(started) >= exclTestWait {
		t.Fatal("TryLock 이어야 하는데 기다렸다")
	}

	// common 칸의 잡(fetch)도 막는다 — 그 잡이 lock 을 만든 주인일 수 있다.
	if code, out := gitReq(t, s, http.MethodPost, "/api/git/fetch", `{"repo":`+qWorkRepo+`}`); code != http.StatusOK {
		t.Fatalf("fetch 시작 = %d %v", code, out)
	}
	code, out = gitReq(t, s, http.MethodPost, "/api/git/lock/remove", body)
	if code != http.StatusConflict || out["error"] != apierr.CodeJobBusy {
		t.Fatalf("잡 진행 중 = %d %v, want 409 job_busy", code, out)
	}
	if _, err := os.Lstat(lock); err != nil {
		t.Fatalf("거절했는데 지웠다: %v", err)
	}
}
