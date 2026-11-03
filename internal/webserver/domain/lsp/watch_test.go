package lsp

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
	"time"

	"dongminal/internal/shared/platform"
)

// ── 끼워 넣기 (CODEMIRROR_MIGRATION_SRS FR-CMR-110·113·114 · §11.6 W) ──

type watchMsg struct {
	Method string `json:"method"`
	Params struct {
		Changes []struct {
			URI  string `json:"uri"`
			Type int    `json:"type"`
		} `json:"changes"`
	} `json:"params"`
}

func readMsg(t *testing.T, e *pipeEnd) watchMsg {
	t.Helper()
	type res struct {
		b   []byte
		err error
	}
	ch := make(chan res, 1)
	go func() { b, err := readFrame(e.in); ch <- res{b, err} }()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatal(r.err)
		}
		var m watchMsg
		if err := json.Unmarshal(r.b, &m); err != nil {
			t.Fatalf("%v: %s", err, r.b)
		}
		return m
	case <-time.After(2 * time.Second):
		t.Fatal("stdin 에 프레임이 오지 않았다")
		return watchMsg{}
	}
}

// openReady 는 통로를 열고 브라우저의 initialized 를 지나보낸다.
func openReady(t *testing.T, svc *Service, ends chan *pipeEnd, root string) (Tunnel, *pipeEnd) {
	t.Helper()
	tn, err := svc.OpenTunnel(root, "gopls/gopls")
	if err != nil {
		t.Fatal(err)
	}
	e := nextEnd(t, ends)
	done := make(chan struct{})
	go func() { _ = tn.Send([]byte(`{"jsonrpc":"2.0","method":"initialized","params":{}}`)); close(done) }()
	if m := readMsg(t, e); m.Method != "initialized" {
		t.Fatalf("첫 프레임 %q", m.Method)
	}
	// Send 가 LastUse 를 옮기는 것까지 끝난 뒤에 돌려준다 — 시계를 바꾸는 검사와 겹치지 않게.
	<-done
	return tn, e
}

func uris(m watchMsg) []string {
	out := []string{}
	for _, c := range m.Params.Changes {
		out = append(out, c.URI)
	}
	return out
}

func TestNotifyFiles_OnlyAfterInitialized(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	root := t.TempDir()
	tn, err := svc.OpenTunnel(root, "gopls/gopls")
	if err != nil {
		t.Fatal(err)
	}
	e := nextEnd(t, ends)
	a := filepath.Join(root, "a.go")
	go func() {
		svc.NotifyFiles([]FileEvent{{a, WatchChanged}}) // initialized 전 — 버린다
		_ = tn.Send([]byte(`{"jsonrpc":"2.0","method":"initialized","params":{}}`))
		svc.NotifyFiles([]FileEvent{{a, WatchCreated}})
	}()
	if m := readMsg(t, e); m.Method != "initialized" {
		t.Fatalf("initialized 앞에 %q 가 끼었다", m.Method)
	}
	m := readMsg(t, e)
	if m.Method != "workspace/didChangeWatchedFiles" {
		t.Fatalf("method %q", m.Method)
	}
	if len(m.Params.Changes) != 1 || m.Params.Changes[0].Type != WatchCreated ||
		m.Params.Changes[0].URI != platform.Current().Paths.FileURI(a) {
		t.Fatalf("changes %+v", m.Params.Changes)
	}
}

func TestNotifyFiles_OnlyPathsUnderEachRoot(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	base := t.TempDir()
	ra, rb := filepath.Join(base, "a"), filepath.Join(base, "b")
	_, ea := openReady(t, svc, ends, ra)
	_, eb := openReady(t, svc, ends, rb)
	pa, pb := filepath.Join(ra, "x.go"), filepath.Join(rb, "y.go")
	// `a` 의 형제 `ab` 는 `a` 아래가 아니다.
	sib := filepath.Join(base, "ab", "z.go")
	go svc.NotifyFiles([]FileEvent{{pa, WatchChanged}, {pb, WatchDeleted}, {sib, WatchChanged}})
	ma, mb := readMsg(t, ea), readMsg(t, eb)
	if got := uris(ma); !reflect.DeepEqual(got, []string{platform.Current().Paths.FileURI(pa)}) {
		t.Fatalf("a 통로 %v", got)
	}
	if got := uris(mb); !reflect.DeepEqual(got, []string{platform.Current().Paths.FileURI(pb)}) || mb.Params.Changes[0].Type != WatchDeleted {
		t.Fatalf("b 통로 %+v", mb.Params.Changes)
	}
}

// 루트 아래의 것이 없으면 보내지 않는다 — 다음 프레임은 브라우저의 것이다.
func TestNotifyFiles_NothingUnderRootSendsNothing(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	root := t.TempDir()
	tn, e := openReady(t, svc, ends, root)
	go func() {
		svc.NotifyFiles([]FileEvent{{filepath.Join(t.TempDir(), "o.go"), WatchChanged}})
		svc.NotifyFiles(nil)
		_ = tn.Send([]byte(`{"jsonrpc":"2.0","method":"ping"}`))
	}()
	if m := readMsg(t, e); m.Method != "ping" {
		t.Fatalf("빈 끼워 넣기가 나갔다: %q", m.Method)
	}
}

// 한 서버가 stdin 을 읽지 않아도 다른 통로의 끼워 넣기와 호출자는 막히지 않는다. 같은 통로의 순서는 지킨다.
func TestNotifyFiles_StuckTunnelDoesNotBlockOthers(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	base := t.TempDir()
	ra, rb := filepath.Join(base, "a"), filepath.Join(base, "b")
	openReady(t, svc, ends, ra) // 이 서버는 더 읽지 않는다
	_, eb := openReady(t, svc, ends, rb)
	done := make(chan struct{})
	go func() {
		for _, n := range []string{"1.go", "2.go", "3.go"} {
			svc.NotifyFiles([]FileEvent{{filepath.Join(ra, n), WatchChanged}, {filepath.Join(rb, n), WatchChanged}})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("NotifyFiles 가 막힌 통로를 기다렸다")
	}
	for _, n := range []string{"1.go", "2.go", "3.go"} {
		if got := uris(readMsg(t, eb)); !reflect.DeepEqual(got, []string{platform.Current().Paths.FileURI(filepath.Join(rb, n))}) {
			t.Fatalf("b 통로 순서 %v (want %s)", got, n)
		}
	}
}

func TestNotifyFiles_CapsAtWatchMax(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	svc.WatchMax = 3
	root := t.TempDir()
	_, e := openReady(t, svc, ends, root)
	var evs []FileEvent
	var want []string
	for _, n := range []string{"1.go", "2.go", "3.go", "4.go", "5.go"} {
		p := filepath.Join(root, n)
		evs = append(evs, FileEvent{p, WatchChanged})
		if len(want) < 3 {
			want = append(want, platform.Current().Paths.FileURI(p))
		}
	}
	go svc.NotifyFiles(evs)
	if got := uris(readMsg(t, e)); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestNotifyFiles_DefaultWatchMax(t *testing.T) {
	if DefaultWatchMax != 2000 {
		t.Fatalf("LSP_WATCH_MAX 기본은 2000 이다: %d", DefaultWatchMax)
	}
	if (&Service{}).watchMax() != DefaultWatchMax {
		t.Fatal("WatchMax 0 이면 기본값이다")
	}
}

// 끼워 넣기는 사용자의 쓰임이 아니다 — 유휴 판단을 늦추지 않는다. 브라우저 쪽으로도 아무것도 가지 않는다.
func TestNotifyFiles_NoTouchAndNothingToBrowser(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	var mu sync.Mutex
	now := time.Unix(1000, 0)
	svc.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	root := t.TempDir()
	tn, e := openReady(t, svc, ends, root)
	before := tn.LastUse()
	mu.Lock()
	now = now.Add(time.Hour)
	mu.Unlock()
	go svc.NotifyFiles([]FileEvent{{filepath.Join(root, "a.go"), WatchChanged}})
	readMsg(t, e)
	if !tn.LastUse().Equal(before) {
		t.Fatalf("끼워 넣기가 LastUse 를 %v → %v 로 옮겼다", before, tn.LastUse())
	}
	back := []byte(`{"jsonrpc":"2.0","method":"from-server"}`)
	go func() { _ = writeFrame(e.out, back) }()
	got, err := tn.Recv()
	if err != nil || string(got) != string(back) {
		t.Fatalf("브라우저 쪽 첫 프레임 %q (%v)", got, err)
	}
}

// ── 바뀐 파일 목록 (FR-CMR-111·112) ──

func exists(set ...string) func(string) bool {
	m := map[string]bool{}
	for _, p := range set {
		m[p] = true
	}
	return func(p string) bool { return m[p] }
}

func TestRepoEvents_HeadMove(t *testing.T) {
	repo := t.TempDir()
	at := func(rel string) string { return filepath.Join(repo, filepath.FromSlash(rel)) }
	prev := &RepoSnap{Head: "h1", Files: map[string]bool{}}
	cur := RepoSnap{Head: "h2", Files: map[string]bool{}}
	ns := []NameStatus{
		{Status: "A", Path: "new.go"}, {Status: "D", Path: "old.go"}, {Status: "M", Path: "pkg/mod.go"},
		{Status: "R", OrigPath: "a.go", Path: "b.go"},
	}
	got := repoEvents(repo, prev, cur, ns, exists(at("new.go"), at("pkg/mod.go"), at("b.go")))
	want := []FileEvent{
		{at("a.go"), WatchDeleted}, {at("b.go"), WatchCreated}, {at("new.go"), WatchCreated},
		{at("old.go"), WatchDeleted}, {at("pkg/mod.go"), WatchChanged},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

func TestRepoEvents_WorktreeUnion(t *testing.T) {
	repo := t.TempDir()
	at := func(rel string) string { return filepath.Join(repo, rel) }
	prev := &RepoSnap{Head: "h", Files: map[string]bool{"x.go": false, "reverted.go": false}}
	cur := RepoSnap{Head: "h", Files: map[string]bool{"x.go": false, "u.go": true, "gone.go": false}}
	got := repoEvents(repo, prev, cur, nil, exists(at("x.go"), at("u.go"), at("reverted.go")))
	want := []FileEvent{
		{at("gone.go"), WatchDeleted}, {at("reverted.go"), WatchChanged},
		{at("u.go"), WatchCreated}, {at("x.go"), WatchChanged},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

func TestRepoEvents_FirstSnapshotAndDedupe(t *testing.T) {
	repo := t.TempDir()
	at := func(rel string) string { return filepath.Join(repo, rel) }
	cur := RepoSnap{Head: "h", Files: map[string]bool{"n.go": true}}
	if got := repoEvents(repo, nil, cur, nil, exists(at("n.go"))); !reflect.DeepEqual(got, []FileEvent{{at("n.go"), WatchCreated}}) {
		t.Fatalf("첫 관측 %v", got)
	}
	// 한 경로가 여러 근거에 있어도 한 번이다. 새 파일이라는 근거가 하나라도 있으면 Created 다.
	prev := &RepoSnap{Head: "h0", Files: map[string]bool{"n.go": false}}
	got := repoEvents(repo, prev, RepoSnap{Head: "h1", Files: map[string]bool{"n.go": false}},
		[]NameStatus{{Status: "A", Path: "n.go"}}, exists(at("n.go")))
	if !reflect.DeepEqual(got, []FileEvent{{at("n.go"), WatchCreated}}) {
		t.Fatalf("중복 %v", got)
	}
	if got := repoEvents(repo, &RepoSnap{Head: "h"}, RepoSnap{Head: "h"}, nil, exists()); len(got) != 0 {
		t.Fatalf("바뀐 것이 없는데 %v", got)
	}
}

// ── RepoWatch ──

type fakeView struct {
	snaps map[string]RepoSnap
	ns    []NameStatus
	nsErr error
	asked [][2]string
}

func (f *fakeView) Snapshot(repo string) (RepoSnap, bool) { s, ok := f.snaps[repo]; return s, ok }
func (f *fakeView) NameStatus(_ context.Context, _ string, from, to string) ([]NameStatus, error) {
	f.asked = append(f.asked, [2]string{from, to})
	return f.ns, f.nsErr
}

type fakeOut struct{ got [][]FileEvent }

func (f *fakeOut) NotifyFiles(e []FileEvent) { f.got = append(f.got, e) }

func TestRepoWatch_RemembersAndAsksOnlyOnHeadMove(t *testing.T) {
	repo := t.TempDir()
	at := func(rel string) string { return filepath.Join(repo, rel) }
	v := &fakeView{snaps: map[string]RepoSnap{repo: {Head: "h1", Files: map[string]bool{"a.go": false}}}}
	out := &fakeOut{}
	w := &RepoWatch{View: v, Out: out, Exists: exists(at("a.go"), at("b.go"))}

	w.Changed(repo)
	if len(v.asked) != 0 {
		t.Fatalf("첫 관측에 name-status 를 물었다: %v", v.asked)
	}
	if len(out.got) != 1 || !reflect.DeepEqual(out.got[0], []FileEvent{{at("a.go"), WatchChanged}}) {
		t.Fatalf("첫 알림 %v", out.got)
	}

	// 같은 HEAD — 묻지 않는다. 직전 집합의 a.go 와 지금의 b.go 가 함께 간다.
	v.snaps[repo] = RepoSnap{Head: "h1", Files: map[string]bool{"b.go": true}}
	w.Changed(repo)
	if len(v.asked) != 0 {
		t.Fatalf("HEAD 가 그대로인데 물었다: %v", v.asked)
	}
	if !reflect.DeepEqual(out.got[1], []FileEvent{{at("a.go"), WatchChanged}, {at("b.go"), WatchCreated}}) {
		t.Fatalf("둘째 알림 %v", out.got[1])
	}

	// HEAD 이동 — 직전 → 지금을 묻는다. b.go 는 이제 커밋됐다(지금 집합에 없다) — Changed 다.
	v.snaps[repo] = RepoSnap{Head: "h2", Files: map[string]bool{}}
	v.ns = []NameStatus{{Status: "M", Path: "c.go"}}
	w.Exists = exists(at("b.go"), at("c.go"))
	w.Changed(repo)
	if !reflect.DeepEqual(v.asked, [][2]string{{"h1", "h2"}}) {
		t.Fatalf("물은 범위 %v", v.asked)
	}
	if !reflect.DeepEqual(out.got[2], []FileEvent{{at("b.go"), WatchChanged}, {at("c.go"), WatchChanged}}) {
		t.Fatalf("셋째 알림 %v", out.got[2])
	}
}

func TestRepoWatch_NoSnapshotOrNothingChanged(t *testing.T) {
	repo := t.TempDir()
	v := &fakeView{snaps: map[string]RepoSnap{}}
	out := &fakeOut{}
	w := &RepoWatch{View: v, Out: out, Exists: exists()}
	w.Changed(repo)
	v.snaps[repo] = RepoSnap{Head: "h", Files: map[string]bool{}}
	w.Changed(repo)
	if len(out.got) != 0 {
		t.Fatalf("알릴 것이 없는데 알렸다: %v", out.got)
	}
}

// name-status 를 얻지 못해도 작업 트리 변경은 알린다.
func TestRepoWatch_NameStatusErrorStillSendsWorktree(t *testing.T) {
	repo := t.TempDir()
	at := func(rel string) string { return filepath.Join(repo, rel) }
	v := &fakeView{snaps: map[string]RepoSnap{repo: {Head: "h1", Files: map[string]bool{}}}}
	out := &fakeOut{}
	w := &RepoWatch{View: v, Out: out, Exists: exists(at("w.go"))}
	w.Changed(repo)
	v.snaps[repo] = RepoSnap{Head: "h2", Files: map[string]bool{"w.go": false}}
	v.nsErr = errors.New("boom")
	w.Changed(repo)
	if len(out.got) != 1 || !reflect.DeepEqual(out.got[0], []FileEvent{{at("w.go"), WatchChanged}}) {
		t.Fatalf("알림 %v", out.got)
	}
}

// Seen 은 기준선만 적는다 — 첫 Changed 가 HEAD 이동을 안다.
func TestRepoWatch_SeenSetsBaselineWithoutNotify(t *testing.T) {
	repo := t.TempDir()
	at := func(rel string) string { return filepath.Join(repo, rel) }
	v := &fakeView{snaps: map[string]RepoSnap{repo: {Head: "h1", Files: map[string]bool{}}}}
	out := &fakeOut{}
	w := &RepoWatch{View: v, Out: out, Exists: exists(at("c.go"))}
	w.Seen(repo)
	if len(out.got) != 0 {
		t.Fatalf("Seen 이 알렸다: %v", out.got)
	}
	v.snaps[repo] = RepoSnap{Head: "h2", Files: map[string]bool{}}
	v.ns = []NameStatus{{Status: "A", Path: "c.go"}}
	w.Changed(repo)
	if !reflect.DeepEqual(v.asked, [][2]string{{"h1", "h2"}}) {
		t.Fatalf("물은 범위 %v", v.asked)
	}
	if len(out.got) != 1 || !reflect.DeepEqual(out.got[0], []FileEvent{{at("c.go"), WatchCreated}}) {
		t.Fatalf("알림 %v", out.got)
	}
}
