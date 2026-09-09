package hub

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
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
type fakeSigner struct {
	sigs  map[string]string
	files map[string][]string
	errs  map[string]error
	calls int
}

func (f *fakeSigner) Status(_ context.Context, repo string) (store.Observation, bool, error) {
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

// G-7: 회차마다 관측은 **정확히 한 번**이다.
//
// 감시자가 Store 를 여러 번 부르면 그만큼 git 이 돈다 — TTL 캐시가 그중 일부를
// 먹더라도 그것에 기대는 설계는 아니다. `GitObserver` 인터페이스에 메서드가
// 하나뿐인 것이 그 경계다.
func TestGitWatch_UsesSignatureOnly(t *testing.T) {
	sig := &fakeSigner{sigs: map[string]string{"/r": "a"}}
	w := newWatcher(sig, &fakeBroker{})
	note(t, w, sig, "/r")
	w.Tick(context.Background())
	w.Tick(context.Background())
	if sig.calls != 2 {
		t.Fatalf("회차마다 정확히 한 번 읽어야 한다: %d (G-7)", sig.calls)
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
	w.Tick(context.Background())

	if got := gitChangedRepos(br); len(got) != 1 {
		t.Fatalf("작업 트리 변화를 알리지 않았다: %v (G-8)", got)
	}
	// 그대로면 다시 알리지 않는다 — 변화 감지가 넓어졌다고 시끄러워지면 안 된다.
	w.Tick(context.Background())
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
	w.Tick(context.Background())
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
