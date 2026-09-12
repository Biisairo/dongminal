package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/git/query"
	"dongminal/internal/webserver/domain/git/store"
)

// GIT_PUSH_OBSERVE_SRS §4.1 — 서버 감시자의 계약 (G-1~G-7).
//
// 감시자는 git 저장소가 없어도 시험된다. `GitSigner` 를 인터페이스로 둔 이유가
// 그것이다 — 재는 것은 "언제 방송하는가" 이지 signature 가 무엇을 stat 하는가가
// 아니다 (그쪽은 `query/signature_test.go` 의 몫이다).

// fakeSigner 는 관측 하나를 흉내낸다. `sigs` 는 signature 값이고 `files` 는
// **작업 트리** 쪽 변화다 — 둘을 따로 두는 이유는 signature 가 `.git` 만 보고
// 작업 트리를 보지 못한다는 것이 이 SRS 의 핵심 발견이기 때문이다 (§2.7).
//
// GIT_DETECT_TIER_SRS FR-GDT-1: **1차 게이트가 생겼다.** `sigCalls` 가 그것의
// 호출 수이고 `calls` 는 여전히 2차(`git status`)의 것이다 — 두 수를 따로 세지
// 않으면 "변화가 없을 때 git 이 도는가" 를 잴 수 없다.
type fakeSigner struct {
	sigs     map[string]string
	files    map[string][]string
	errs     map[string]error
	sigErrs  map[string]error
	calls    int
	sigCalls int
	mu       sync.Mutex
}

func (f *fakeSigner) Signature(_ context.Context, repo string) (query.Signature, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sigCalls++
	if err, ok := f.sigErrs[repo]; ok && err != nil {
		return query.Signature{}, err
	}
	// 작업 트리 변화는 signature 에 **잡히지 않는다** — 그것이 2단 게이트가
	// 워크트리 회차를 따로 두는 이유다 (FR-GDT-3).
	return query.Signature{Value: f.sigs[repo]}, nil
}

func (f *fakeSigner) Status(_ context.Context, repo string) (store.Observation, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if err, ok := f.errs[repo]; ok && err != nil {
		return store.Observation{}, false, err
	}
	obs := store.Observation{Signature: query.Signature{Value: f.sigs[repo]}}
	for _, p := range f.files[repo] {
		obs.Status.Untracked = append(obs.Status.Untracked, query.FileEntry{Path: p, XY: "??"})
	}
	return obs, false, nil
}

// `fakeBroker` 는 `foreground_test.go` 의 것을 쓴다 — 같은 패키지이고 재는 것도
// 같다(무엇이 방송됐는가). 대역을 둘로 두면 그 둘이 어긋날 수 있다.

// gitChangedRepos 는 방송된 것 중 `git_changed` 의 repo 만 뽑는다.
func gitChangedRepos(b *fakeBroker) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := []string{}
	for _, p := range b.sent {
		var m struct {
			Action string `json:"action"`
			Args   struct {
				Repo string `json:"repo"`
				Mark string `json:"mark"`
			} `json:"args"`
		}
		if json.Unmarshal(p, &m) == nil && m.Action == "git_changed" {
			out = append(out, m.Args.Repo)
		}
	}
	return out
}

func newWatcher(sig *fakeSigner, br *fakeBroker) *GitWatcher {
	return NewGitWatcher(sig, br)
}

// note 는 "브라우저가 방금 status 를 받았다" 를 흉내낸다 — 그 응답이 곧 기준선이다.
func note(t *testing.T, w *GitWatcher, sig *fakeSigner, repo string) {
	t.Helper()
	obs, _, err := sig.Status(context.Background(), repo)
	if err != nil {
		obs = store.Observation{}
	}
	sig.calls-- // 표명은 감시 회차가 아니다. 회차 수를 세는 검사가 흔들리지 않게 되돌린다.
	w.Note(repo, obs)
}

// G-1·G-2: 값이 그대로면 방송이 없고, 바뀌면 한 번만 있다.
//
// 첫 회차는 기준선이라 방송하지 않는다 — 그때의 값은 "바뀐 것" 이 아니고,
// 브라우저는 방금 status 를 받아 이미 알고 있다.
func TestGitWatch_BroadcastsOnlyOnChange(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	br := &fakeBroker{}
	w := newWatcher(sig, br)
	note(t, w, sig, "/r")

	w.Tick(context.Background()) // 기준선
	if n := br.count(); n != 0 {
		t.Fatalf("첫 회차가 방송했다: %d", n)
	}
	w.Tick(context.Background()) // 그대로
	if n := br.count(); n != 0 {
		t.Fatalf("값이 그대로인데 방송했다: %d (G-1)", n)
	}

	sig.sigs["/r"] = "b"
	w.Tick(context.Background())
	if got := gitChangedRepos(br); len(got) != 1 || got[0] != "/r" {
		t.Fatalf("변화를 한 번 알리지 않았다: %v (G-2)", got)
	}
	w.Tick(context.Background()) // 새 값이 기준선이 됐다
	if n := len(gitChangedRepos(br)); n != 1 {
		t.Fatalf("같은 변화를 두 번 알렸다: %d (G-2)", n)
	}
}

// G-3: 표명이 없으면 아무것도 읽지 않는다. 빈 순회는 맵 하나를 보는 일이다.
func TestGitWatch_NoInterestNoRead(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	w := newWatcher(sig, &fakeBroker{})
	for i := 0; i < 5; i++ {
		w.Tick(context.Background())
	}
	if sig.calls != 0 {
		t.Fatalf("표명이 없는데 %d 회 읽었다 (G-3)", sig.calls)
	}
}

// G-4: 표명은 만료된다. 브라우저의 안전망 폴링이 그보다 잦으므로, 보고 있는
// 동안에는 만료되지 않는다.
func TestGitWatch_InterestExpires(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	w := newWatcher(sig, &fakeBroker{})
	now := time.Now()
	w.now = func() time.Time { return now }

	note(t, w, sig, "/r")
	if w.Watching() != 1 {
		t.Fatalf("표명이 등록되지 않았다")
	}
	now = now.Add(GitWatchTTL / 2)
	w.Tick(context.Background())
	if w.Watching() != 1 {
		t.Fatalf("TTL 안인데 만료됐다 (G-4)")
	}
	now = now.Add(GitWatchTTL)
	w.Tick(context.Background())
	if w.Watching() != 0 {
		t.Fatalf("TTL 을 넘겼는데 남아 있다 (G-4)")
	}
}

// G-4b: 표명을 다시 하면 수명이 갱신된다 — status 요청이 그 역할을 겸한다.
func TestGitWatch_NoteRefreshes(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{}}
	w := newWatcher(sig, &fakeBroker{})
	now := time.Now()
	w.now = func() time.Time { return now }

	note(t, w, sig, "/r")
	now = now.Add(GitWatchTTL - time.Second)
	note(t, w, sig, "/r") // 브라우저가 안전망 주기로 다시 물었다
	now = now.Add(GitWatchTTL - time.Second)
	w.Tick(context.Background())
	if w.Watching() != 1 {
		t.Fatalf("갱신된 표명이 만료됐다 (G-4b)")
	}
}

// G-5: 상한을 넘으면 가장 오래된 표명부터 빠진다.
func TestGitWatch_CapEvictsOldest(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{}}
	w := newWatcher(sig, &fakeBroker{})
	now := time.Now()
	w.now = func() time.Time { return now }

	for i := 0; i < GitWatchCap+3; i++ {
		note(t, w, sig, string(rune('a'+i))+":/r")
		now = now.Add(time.Millisecond)
	}
	if got := w.Watching(); got != GitWatchCap {
		t.Fatalf("상한을 지키지 않았다: %d (G-5)", got)
	}
	// 가장 먼저 표명한 것이 빠졌다.
	w.mu.Lock()
	_, stillThere := w.watch["a:/r"]
	w.mu.Unlock()
	if stillThere {
		t.Fatalf("가장 오래된 표명이 살아남았다 (G-5)")
	}
}

// G-6: 읽기 오류는 그 저장소를 대상에서 뺀다.
//
// 저장소가 사라졌거나 gitdir 이 깨진 것이고, 그 판정과 화면 처리는 브라우저의
// GIT_REPO_MISSING 경로가 이미 갖고 있다 (FR-RMS-6). 감시자가 흉내내지 않는다.
func TestGitWatch_ErrorDropsRepo(t *testing.T) {
	sig := &fakeSigner{
		sigs: map[string]string{"/ok": "a", "/gone": "x"},
		errs: map[string]error{"/gone": errors.New("no such gitdir")},
	}
	br := &fakeBroker{}
	w := newWatcher(sig, br)
	note(t, w, sig, "/ok")
	note(t, w, sig, "/gone")

	w.Tick(context.Background())
	if w.Watching() != 1 {
		t.Fatalf("오류난 저장소가 대상에 남았다: %d (G-6)", w.Watching())
	}
	if br.count() != 0 {
		t.Fatalf("오류를 방송했다 (G-6)")
	}
	// 남은 쪽은 계속 감시된다.
	sig.sigs["/ok"] = "b"
	w.Tick(context.Background())
	if got := gitChangedRepos(br); len(got) != 1 || got[0] != "/ok" {
		t.Fatalf("살아 있는 저장소의 변화를 놓쳤다: %v (G-6)", got)
	}
}

// G-7 → **V-GDT-1·2 로 개정** (GIT_DETECT_TIER_SRS 묶음 A).
//
//	이전 동작: 회차마다 `Status`(= `git status` 프로세스) **정확히 한 번**.
//	          아무 변화가 없어도 1초마다, 최대 16개 저장소 동시에
//	새  동작: 회차마다 `Signature` 한 번. `Status` 는 **필요한 회차에만**
//	이유:     `GIT_PUSH_OBSERVE_SRS §1.2` 가 fsnotify 를 기각하며 든 근거가
//	          "`ReadSignature` = 0.02ms 이므로 싸다" 였는데 구현이 그 자리에서
//	          `git status` 를 돌려 그 근거를 스스로 무효로 만들었다 (`11 GP-7`)
//
// **"정확히 한 번" 의 계약은 살아 있다** — 자리가 2차에서 1차로 옮겨졌을 뿐이다.
func TestGitWatch_FirstGateIsSignature(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	w := newWatcher(sig, &fakeBroker{})
	note(t, w, sig, "/r")
	// 워크트리 회차를 피해 재려면 위상을 알아야 한다. 위상은 저장소 경로에서
	// 나오므로 결정적이다 (FR-GDT-4).
	base := sig.calls
	nonWorktree := 0
	for i := 0; i < GitWatchWorktreeEvery; i++ {
		before := sig.calls
		w.Tick(context.Background())
		if sig.calls == before {
			nonWorktree++
		}
	}
	if sig.sigCalls != GitWatchWorktreeEvery {
		t.Fatalf("1차 게이트가 회차마다 한 번이 아니다: %d (V-GDT-1)", sig.sigCalls)
	}
	// GitWatchWorktreeEvery 회차 중 워크트리 회차는 정확히 하나다.
	if nonWorktree != GitWatchWorktreeEvery-1 {
		t.Fatalf("변화가 없는데 git status 가 %d 회차에서 돌았다 (V-GDT-1)",
			GitWatchWorktreeEvery-nonWorktree)
	}
	if sig.calls-base != 1 {
		t.Fatalf("워크트리 회차가 하나가 아니다: %d (FR-GDT-3)", sig.calls-base)
	}
}

// V-GDT-2: signature 가 바뀐 회차는 2차 관측을 **반드시** 한다.
func TestGitWatch_SignatureChangeForcesStatus(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	br := &fakeBroker{}
	w := newWatcher(sig, br)
	note(t, w, sig, "/r")
	// 워크트리 회차가 아닌 회차를 하나 찾아 그 자리에서 signature 를 바꾼다.
	for i := 0; i < GitWatchWorktreeEvery*2; i++ {
		before := sig.calls
		sig.sigs["/r"] = "a"
		w.Tick(context.Background())
		if sig.calls != before {
			continue // 워크트리 회차였다
		}
		// 여기가 "signature 가 같아 2차를 건너뛴" 회차다. 이제 바꿔 본다.
		sig.sigs["/r"] = "b"
		before = sig.calls
		w.Tick(context.Background())
		if sig.calls != before+1 {
			t.Fatalf("signature 가 바뀌었는데 git status 가 돌지 않았다 (V-GDT-2)")
		}
		if got := gitChangedRepos(br); len(got) != 1 {
			t.Fatalf("signature 가 바뀌었는데 알리지 않았다: %v (V-GDT-2)", got)
		}
		return
	}
	t.Fatal("워크트리 회차가 아닌 회차를 찾지 못했다 — 위상 계산이 깨졌다")
}

// V-GDT-3: signature 를 **읽지 못하면** 관측한다. 판정할 수 없으면 묻는다.
func TestGitWatch_SignatureErrorFallsBackToStatus(t *testing.T) {
	sig := &fakeSigner{
		sigs:    map[string]string{"/r": "a"},
		sigErrs: map[string]error{"/r": errors.New("gitdir 을 읽을 수 없다")},
	}
	w := newWatcher(sig, &fakeBroker{})
	note(t, w, sig, "/r")
	before := sig.calls
	w.Tick(context.Background())
	if sig.calls != before+1 {
		t.Fatalf("1차를 읽지 못했는데 2차를 건너뛰었다 (FR-GDT-2 ③)")
	}
}

// V-GDT-4: 워크트리 회차의 위상이 저장소마다 다르다 — 전부 같은 회차에 몰리면
// 4초마다 16개의 `git status` 가 동시에 뜬다 (D-GDT-2).
func TestGitWatch_WorktreePhaseSpread(t *testing.T) {
	seen := map[uint64]bool{}
	for _, r := range []string{"/a", "/b", "/c", "/d", "/e", "/f", "/g", "/h"} {
		seen[watchPhase(r)] = true
	}
	if len(seen) < 2 {
		t.Fatalf("위상이 흩어지지 않는다: %v (FR-GDT-4)", seen)
	}
	for p := range seen {
		if p >= GitWatchWorktreeEvery {
			t.Fatalf("위상이 회차 범위를 벗어난다: %d", p)
		}
	}
}

// payload 형태가 브라우저의 구독과 어긋나면 조용히 아무 일도 일어나지 않는다.
func TestGitWatch_PayloadShape(t *testing.T) {
	p := gitChangedPayload("/r", "mark-1")
	var m map[string]any
	if err := json.Unmarshal(p, &m); err != nil {
		t.Fatalf("payload 가 JSON 이 아니다: %v", err)
	}
	if m["action"] != "git_changed" {
		t.Fatalf("action 이 다르다: %v", m["action"])
	}
	args, _ := m["args"].(map[string]any)
	if args["repo"] != "/r" || args["mark"] != "mark-1" {
		t.Fatalf("args 가 다르다: %v (FR-GPO-4)", args)
	}
}

// G-8: **작업 트리 변화도 알린다.**
//
// 이 검사가 이 SRS 의 중심이다. 첫 구현은 signature 만 보았고, signature 는
// `HEAD`·`index`·`refs` 를 보므로 작업 트리에 파일이 생겨도 그대로다 — 그래서
// 방송이 나가지 않았고, e2e 가 그것을 잡았다 (§2.7).
//
// 종전에 작업 트리 변화를 잡던 것은 signature 폴링(500ms)이 아니라 **status
// 폴링(1s)** 이었다. 그러므로 서버가 관측하는 것도 status 여야 한다.
func TestGitWatch_WorktreeChangeBroadcasts(t *testing.T) {
	sig := &fakeSigner{
		sigs:  map[string]string{"/r": "same"}, // .git 은 그대로다
		files: map[string][]string{"/r": {}},
	}
	br := &fakeBroker{}
	w := newWatcher(sig, br)
	note(t, w, sig, "/r")
	w.Tick(context.Background()) // 기준선

	// 작업 트리에만 파일이 생겼다. signature 는 한 글자도 바뀌지 않는다.
	sig.files["/r"] = []string{"new.txt"}
	// GIT_DETECT_TIER_SRS FR-GDT-3 으로 **지연이 생겼다.** signature 가 그대로면
	// 2차 관측은 워크트리 회차에서만 돈다 — 그 간격 안에 한 번은 반드시 온다.
	//
	//   이전 동작: 다음 회차(1초)에 알렸다
	//   새  동작: 워크트리 회차(최대 GitWatchWorktreeEvery 회차)에 알린다
	//   이유:     그 지연의 대가로 "변화가 없어도 1초마다 git status" 가 사라진다.
	//             브라우저 안전망(30초)보다 훨씬 짧으므로 사용자가 겪는 갱신은
	//             여전히 서버 푸시다 (FR-GDT-6)
	for i := 0; i < GitWatchWorktreeEvery; i++ {
		w.Tick(context.Background())
	}

	if got := gitChangedRepos(br); len(got) != 1 {
		t.Fatalf("작업 트리 변화를 알리지 않았다: %v (G-8 · FR-GDT-3)", got)
	}
	// 그대로면 다시 알리지 않는다 — 변화 감지가 넓어졌다고 시끄러워지면 안 된다.
	for i := 0; i < GitWatchWorktreeEvery; i++ {
		w.Tick(context.Background())
	}
	if n := len(gitChangedRepos(br)); n != 1 {
		t.Fatalf("변화가 없는데 또 알렸다: %d (G-1)", n)
	}
}

// G-9: 파일의 **상태**만 바뀌어도 알린다 (스테이지 등). 목록 길이는 그대로다.
func TestGitWatch_FileStateChangeBroadcasts(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "s"}, files: map[string][]string{"/r": {"a.txt"}}}
	br := &fakeBroker{}
	w := newWatcher(sig, br)
	note(t, w, sig, "/r")
	w.Tick(context.Background())

	sig.files["/r"] = []string{"b.txt"} // 같은 수, 다른 파일
	// FR-GDT-3: 작업 트리 쪽이므로 워크트리 회차를 기다린다 (G-8 과 같은 이유).
	for i := 0; i < GitWatchWorktreeEvery; i++ {
		w.Tick(context.Background())
	}
	if n := len(gitChangedRepos(br)); n != 1 {
		t.Fatalf("목록이 바뀌었는데 알리지 않았다: %d (G-9)", n)
	}
}

// G-10: **표명과 첫 회차 사이의 변화를 놓치지 않는다.**
//
// 이 결함을 e2e 가 잡았다. `Note` 가 기준선 없이 등록하면 첫 `Tick` 이 그때의
// 관측을 기준선으로 삼는데, 표명과 그 회차 사이에 변화가 생기면 그것이 기준선에
// 섞여 "바뀐 적 없는" 것이 된다 — 창을 열자마자 파일을 만든 화면이 안전망(30초)
// 까지 낡은 채였다.
//
// 브라우저는 표명 시점에 그 관측을 응답으로 받았다. 그러므로 그 값이 곧
// "브라우저가 아는 상태" 이고, 기준선으로 정확하다.
func TestGitWatch_ChangeRightAfterNoteIsNotLost(t *testing.T) {
	sig := &fakeSigner{
		sigs:  map[string]string{"/r": "s"},
		files: map[string][]string{"/r": {}},
	}
	br := &fakeBroker{}
	w := newWatcher(sig, br)

	note(t, w, sig, "/r") // 브라우저가 status 를 받았다 — 그때는 파일이 없었다

	// 첫 회차가 돌기 **전에** 파일이 생긴다. 실제로 이 창은 방금 열렸다.
	sig.files["/r"] = []string{"raced.txt"}

	w.Tick(context.Background())
	if got := gitChangedRepos(br); len(got) != 1 {
		t.Fatalf("표명 직후의 변화를 놓쳤다: %v (G-10)", got)
	}
}

// G-10b: 재표명은 기준선을 덮지 않는다.
//
// 브라우저가 안전망 주기로 다시 물을 때 그 응답으로 기준선을 갈아 끼우면,
// 마지막 방송과 그 응답 사이에 생긴 변화를 잃는다.
func TestGitWatch_RenoteDoesNotResetBaseline(t *testing.T) {
	sig := &fakeSigner{
		sigs:  map[string]string{"/r": "s"},
		files: map[string][]string{"/r": {}},
	}
	br := &fakeBroker{}
	w := newWatcher(sig, br)
	note(t, w, sig, "/r")

	sig.files["/r"] = []string{"a.txt"}
	note(t, w, sig, "/r") // 안전망 폴링이 새 상태를 받아 갔다
	// 기준선이 여기서 갱신되면 아래 회차가 조용하다. 그러면 이 변화를 본 것은
	// 안전망뿐이고, 푸시는 한 박자 늦는다.
	w.Tick(context.Background())
	if n := len(gitChangedRepos(br)); n != 1 {
		t.Fatalf("재표명이 기준선을 덮어 변화를 삼켰다: %d (G-10b)", n)
	}
}

// TC-GLW-7 (GIT_LIVE_TRIGGERS_SRS FR-GLW-7): 감시 대상이 사라지는 두 경로가
// 로그에서 **구분된다.**
//
// 만료는 브라우저가 말을 멈춘 것이고 탈락은 저장소가 읽히지 않은 것이다. 사후
// 조사에서 "방송이 오지 않았다" 의 원인을 그 둘로 가르지 못하면 다음 접수도 같은
// 자리에서 막힌다 (SRS §2.3).
func captureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	outw, flags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() { log.SetOutput(outw); log.SetFlags(flags) }()
	fn()
	return buf.String()
}

func TestGitWatch_LogsExpiryAndDrop(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/stale": "a"}}
	w := newWatcher(sig, &fakeBroker{})
	now := time.Now()
	w.now = func() time.Time { return now }

	note(t, w, sig, "/stale")
	now = now.Add(2 * GitWatchTTL)
	expired := captureLog(t, func() { w.Tick(context.Background()) })
	if w.Watching() != 0 {
		t.Fatalf("TTL 을 넘겼는데 남아 있다")
	}
	if !strings.Contains(expired, "/stale") || !strings.Contains(expired, "[gitwatch]") {
		t.Fatalf("만료가 로그에 남지 않았다: %q (FR-GLW-7)", expired)
	}

	sig2 := &fakeSigner{
		sigs: map[string]string{"/gone": "x"},
		errs: map[string]error{"/gone": errors.New("no such gitdir")},
	}
	w2 := newWatcher(sig2, &fakeBroker{})
	note(t, w2, sig2, "/gone")
	dropped := captureLog(t, func() { w2.Tick(context.Background()) })
	if w2.Watching() != 0 {
		t.Fatalf("오류난 저장소가 대상에 남았다")
	}
	if !strings.Contains(dropped, "/gone") || !strings.Contains(dropped, "[gitwatch]") {
		t.Fatalf("탈락이 로그에 남지 않았다: %q (FR-GLW-7)", dropped)
	}
	// 두 줄이 **서로 다른 문구**여야 한다 — 같으면 구분이 되지 않는다.
	if strip(expired) == strip(dropped) {
		t.Fatalf("만료와 탈락이 같은 문구다: %q (FR-GLW-7)", expired)
	}
}

// strip 은 저장소 경로를 지운 나머지다 — 문구가 같은지만 보기 위한 것이다.
func strip(s string) string {
	s = strings.ReplaceAll(s, "/stale", "")
	return strings.ReplaceAll(s, "/gone", "")
}

// ── GIT_WATCH_LEASE_SRS §4.1 — 임대를 SSE 구독이 쥔다 (TC-GWL-1~8) ──────────
//
// 여기서 재는 것은 **감시가 언제 걷히는가** 하나다. 종전에는 그 답이 "마지막
// status 요청에서 90초" 뿐이었고, 그래서 안전망 폴링을 끄면 본줄인 push 까지
// 죽었다 (GP-1). 새 답은 "그 저장소를 보는 연결이 끊겼을 때" 다.

// noteFor 는 clientId 를 실은 표명이다. `note` 와 같은 이유로 회차 수를 되돌린다.
func noteFor(t *testing.T, w *GitWatcher, sig *fakeSigner, repo, clientID string) {
	t.Helper()
	obs, _, err := sig.Status(context.Background(), repo)
	if err != nil {
		obs = store.Observation{}
	}
	sig.calls--
	w.NoteFor(repo, obs, clientID)
}

// TC-GWL-1 (FR-GWL-2): 임차인이 있으면 유휴 시간으로 만료되지 않는다.
//
// 사용자 요구가 이것이다 — "오래 안 본다고 지우는 건 안 될 거 같아. 띄워놓고
// 보고만 있을 수도 있으니까." TTL 의 몇 배를 기다려도 남아야 한다.
func TestGitWatch_LeaseSurvivesIdle(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	w := newWatcher(sig, &fakeBroker{})
	now := time.Now()
	w.now = func() time.Time { return now }

	ep := w.Attach("c1")
	if ep == 0 {
		t.Fatalf("Attach 가 epoch 를 주지 않았다")
	}
	noteFor(t, w, sig, "/r", "c1")

	for i := 0; i < 5; i++ {
		now = now.Add(GitWatchTTL)
		w.Tick(context.Background())
	}
	if w.Watching() != 1 {
		t.Fatalf("연결이 살아 있는데 유휴로 만료됐다 (FR-GWL-2)")
	}
}

// TC-GWL-2: 임대만 살아 있고 관측이 죽어 있으면 뜻이 없다 — 그 사이의 변화가
// 실제로 방송되는지 본다.
func TestGitWatch_LeaseStillBroadcasts(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	br := &fakeBroker{}
	w := newWatcher(sig, br)
	now := time.Now()
	w.now = func() time.Time { return now }

	w.Attach("c1")
	noteFor(t, w, sig, "/r", "c1")

	now = now.Add(GitWatchTTL * 3)
	sig.sigs["/r"] = "b"
	w.Tick(context.Background())

	if got := gitChangedRepos(br); len(got) != 1 || got[0] != "/r" {
		t.Fatalf("TTL 을 훌쩍 넘긴 뒤의 변화가 방송되지 않았다: %v (FR-GWL-2)", got)
	}
}

// TC-GWL-3 (FR-GWL-4): 구독이 끊기면 TTL 이 다시 적용된다. 브라우저를 닫으면
// 감시가 곧 걷힌다 — 임대를 늘린 것이 "영원히 본다" 가 되면 안 된다.
func TestGitWatch_DetachRestoresTTL(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	w := newWatcher(sig, &fakeBroker{})
	now := time.Now()
	w.now = func() time.Time { return now }

	ep := w.Attach("c1")
	noteFor(t, w, sig, "/r", "c1")
	w.Detach("c1", ep)

	now = now.Add(GitWatchTTL / 2)
	w.Tick(context.Background())
	if w.Watching() != 1 {
		t.Fatalf("Detach 직후 TTL 안인데 걷혔다 (FR-GWL-4)")
	}
	now = now.Add(GitWatchTTL)
	w.Tick(context.Background())
	if w.Watching() != 0 {
		t.Fatalf("Detach 뒤에도 TTL 이 적용되지 않았다 (FR-GWL-4)")
	}
}

// TC-GWL-4 (FR-GWL-3): 옛 epoch 의 Detach 는 새 구독의 임대를 지우지 않는다.
//
// 재연결에서 옛 연결의 정리가 늦게 도착한다. FocusRegistry 가 FR-XDF-10 으로
// 이미 막아 둔 자리이고, 같은 규약을 여기서도 지킨다.
func TestGitWatch_StaleDetachIgnored(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	w := newWatcher(sig, &fakeBroker{})
	now := time.Now()
	w.now = func() time.Time { return now }

	old := w.Attach("c1")
	noteFor(t, w, sig, "/r", "c1")
	w.Attach("c1") // 재연결 — 새 구독이 같은 신원을 든다
	w.Detach("c1", old)

	now = now.Add(GitWatchTTL * 3)
	w.Tick(context.Background())
	if w.Watching() != 1 {
		t.Fatalf("옛 구독의 정리가 새 임대를 지웠다 (FR-GWL-3)")
	}
}

// TC-GWL-5 (FR-GWL-5): clientId 없는 표명은 종전 TTL 임대 그대로다.
// 옛 화면·스크립트·curl 이 그렇게 부른다.
func TestGitWatch_AnonymousNoteKeepsTTL(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	w := newWatcher(sig, &fakeBroker{})
	now := time.Now()
	w.now = func() time.Time { return now }

	noteFor(t, w, sig, "/r", "")
	now = now.Add(GitWatchTTL * 2)
	w.Tick(context.Background())
	if w.Watching() != 0 {
		t.Fatalf("익명 표명이 만료되지 않았다 (FR-GWL-5)")
	}
}

// TC-GWL-6: 임차인 둘 중 하나만 나가면 감시가 남는다. 창을 둘 띄워 두고 하나만
// 닫는 경우다.
func TestGitWatch_OneHolderLeavesOtherKeeps(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	w := newWatcher(sig, &fakeBroker{})
	now := time.Now()
	w.now = func() time.Time { return now }

	ep1 := w.Attach("c1")
	w.Attach("c2")
	noteFor(t, w, sig, "/r", "c1")
	noteFor(t, w, sig, "/r", "c2")
	w.Detach("c1", ep1)

	now = now.Add(GitWatchTTL * 3)
	w.Tick(context.Background())
	if w.Watching() != 1 {
		t.Fatalf("남은 임차인이 있는데 감시가 걷혔다")
	}
}

// TC-GWL-7 (FR-GWL-6): 상한을 넘으면 임차인 없는 것이 먼저 나가고, 퇴출이
// 로그에 남는다. 종전에는 조용했다 (11-git-polling GP-16).
func TestGitWatch_CapEvictsUnleasedFirstAndLogs(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{}}
	w := newWatcher(sig, &fakeBroker{})
	now := time.Now()
	w.now = func() time.Time { return now }

	// 임차인 있는 것을 **가장 먼저** 표명한다 — 표명 시각만 보면 이것이 먼저
	// 나가야 하는 자리다. 임차인이 그 순서를 뒤집는지 본다.
	w.Attach("c1")
	noteFor(t, w, sig, "/leased", "c1")
	now = now.Add(time.Millisecond)

	out := captureLog(t, func() {
		for i := 0; i < GitWatchCap; i++ {
			noteFor(t, w, sig, string(rune('a'+i))+":/r", "")
			now = now.Add(time.Millisecond)
		}
	})

	if got := w.Watching(); got != GitWatchCap {
		t.Fatalf("상한을 지키지 않았다: %d (FR-GWL-6)", got)
	}
	w.mu.Lock()
	_, leasedThere := w.watch["/leased"]
	w.mu.Unlock()
	if !leasedThere {
		t.Fatalf("임차인 있는 것이 먼저 퇴출됐다 (FR-GWL-6)")
	}
	if !strings.Contains(out, "[gitwatch]") || !strings.Contains(out, "a:/r") {
		t.Fatalf("상한 퇴출이 로그에 남지 않았다: %q (FR-GWL-6)", out)
	}
}

// TC-GWL-8 (FR-GWL-8): Attach 없이 clientId 만 실어 오면 임대가 아니라 TTL 이다.
// 구독이 없는 신원은 "보고 있다" 를 주장할 수 없다.
func TestGitWatch_NoteForUnknownClientIsTTL(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	w := newWatcher(sig, &fakeBroker{})
	now := time.Now()
	w.now = func() time.Time { return now }

	noteFor(t, w, sig, "/r", "ghost")
	now = now.Add(GitWatchTTL * 2)
	w.Tick(context.Background())
	if w.Watching() != 0 {
		t.Fatalf("구독 없는 신원이 임대를 얻었다 (FR-GWL-8)")
	}
}

// NFR-GDT-1 (GIT_DETECT_TIER_SRS): **1분 동안 `git status` 가 60회에서 15회로 준다.**
//
// 사용자가 접수한 진단이 이것이었다 — *"변경이 없어도 1초마다 git 을 돌린다."*
// 그 진단은 정확했고(`11 GP-7`), 이 검사가 그 수를 못박는다.
//
// **프로세스를 세지 않고 회차를 센다.** 실제 프로세스 수를 재려면 격리 인스턴스와
// 1분의 벽시계가 필요하고 그 값은 러너의 부하에 흔들린다 — 여기서 재는 것은
// 설계이고, 설계는 결정적이다.
func TestGitWatch_QuietRepoCost(t *testing.T) {
	const rounds = 60 // GitWatchInterval 이 1초이므로 1분이다
	sig := &fakeSigner{sigs: map[string]string{"/r": "quiet"}}
	w := newWatcher(sig, &fakeBroker{})
	note(t, w, sig, "/r")
	for i := 0; i < rounds; i++ {
		w.Tick(context.Background())
	}
	// 1차 게이트는 회차마다 돈다 — 그것이 싸다는 것이 이 설계의 전부다.
	if sig.sigCalls != rounds {
		t.Fatalf("1차 게이트가 %d 회 돌았다 (기대 %d)", sig.sigCalls, rounds)
	}
	want := rounds / GitWatchWorktreeEvery
	if sig.calls != want {
		t.Fatalf("아무 변화 없는 저장소에서 git status 가 %d 회 돌았다 (기대 %d) — "+
			"NFR-GDT-1 은 60 → 15 이하다", sig.calls, want)
	}
}
