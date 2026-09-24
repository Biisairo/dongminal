package lsp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// REPO_FIX 02 §3A-3·3A-4 — 세션 생존·실패 기억·서버 경로 표.

// liveServer 는 검사가 죽일 수 있는 가짜 언어 서버다.
type liveServer struct {
	srv     *fakeServer
	kill    func() // 서버 쪽 통로를 닫는다 — 크래시
	stopped chan struct{}
}

// killableStarter 는 설 때마다 liveServer 를 채널로 넘긴다. handle 이 nil 이면
// echoHandler 다.
func killableStarter(t *testing.T, handle func(*fakeServer, map[string]any)) (Starter, chan *liveServer, *int32Counter) {
	t.Helper()
	if handle == nil {
		handle = echoHandler
	}
	servers := make(chan *liveServer, 16)
	n := &int32Counter{}
	return func(_ context.Context, _ string, _ []string, _ string) (io.ReadWriteCloser, func(), error) {
		n.inc()
		cr, sw := io.Pipe()
		sr, cw := io.Pipe()
		srv := &fakeServer{fromClient: newBufReader(sr), toClient: sw}
		ls := &liveServer{srv: srv, stopped: make(chan struct{})}
		var once sync.Once
		ls.kill = func() { sw.Close(); sr.Close() }
		go func() {
			for {
				b, err := readFrame(srv.fromClient)
				if err != nil {
					return
				}
				var m map[string]any
				if json.Unmarshal(b, &m) == nil {
					handle(srv, m)
				}
			}
		}()
		servers <- ls
		return rwc{Reader: cr, Writer: cw, closeFn: func() error { cw.Close(); cr.Close(); return nil }},
			func() { once.Do(func() { close(ls.stopped) }) }, nil
	}, servers, n
}

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func waitSessions(t *testing.T, svc *Service, want int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for svc.SessionCount() != want && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if svc.SessionCount() != want {
		t.Fatalf("세션 %d, want %d", svc.SessionCount(), want)
	}
}

func ask(svc *Service) error {
	_, err := svc.Definition(context.Background(), "/root", "/root/a.go", "x\n", 1, 1)
	return err
}

// 크래시: 세션이 맵에서 빠지고 프로세스가 회수(stop)되며, 다음 요청이 새 세션을 세운다.
func TestLifecycle_CrashReapsAndNextRequestRestarts(t *testing.T) {
	start, servers, n := killableStarter(t, nil)
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})
	clk := &fakeClock{t: time.Now()}
	svc.Now = clk.now
	if err := ask(svc); err != nil {
		t.Fatal(err)
	}
	ls := <-servers
	clk.add(2 * time.Minute) // 기동 후 60s 가 지난 크래시 — 기억 없이 곧바로 재기동
	ls.kill()
	waitSessions(t, svc, 0)
	select {
	case <-ls.stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("죽은 세션의 프로세스를 회수하지 않았다")
	}
	if err := ask(svc); err != nil {
		t.Fatalf("크래시 뒤 요청 = %v", err)
	}
	if n.get() != 2 {
		t.Fatalf("기동 %d번, want 2", n.get())
	}
}

// 기동 후 60s 안의 연속 크래시는 1s·2s·4s 로 재시도 간격이 는다.
func TestLifecycle_EarlyCrashBackoff(t *testing.T) {
	start, servers, n := killableStarter(t, nil)
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})
	clk := &fakeClock{t: time.Now()}
	svc.Now = clk.now
	for i, gap := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second} {
		if err := ask(svc); err != nil {
			t.Fatalf("[%d] 기동 요청 = %v", i, err)
		}
		(<-servers).kill()
		waitSessions(t, svc, 0)
		before := n.get()
		clk.add(gap - time.Millisecond)
		if err := ask(svc); err == nil || n.get() != before {
			t.Fatalf("[%d] 백오프(%v) 안에 재기동했다 (err=%v)", i, gap, err)
		}
		clk.add(time.Millisecond)
	}
}

// initialize 실패는 캐시에 고착되지 않는다 — 맵에서 빠지고 백오프 뒤 다시 선다.
func TestLifecycle_HandshakeFailureNotStuck(t *testing.T) {
	fail := true
	var mu sync.Mutex
	start, _, n := killableStarter(t, func(s *fakeServer, m map[string]any) {
		mu.Lock()
		f := fail
		mu.Unlock()
		if m["method"] == "initialize" && f {
			s.replyErrorRaw(m["id"], -32603, "boom")
			return
		}
		echoHandler(s, m)
	})
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})
	clk := &fakeClock{t: time.Now()}
	svc.Now = clk.now
	if err := ask(svc); err == nil {
		t.Fatal("핸드셰이크 실패인데 성공했다")
	}
	waitSessions(t, svc, 0)
	if err := ask(svc); err == nil || n.get() != 1 {
		t.Fatalf("백오프 안에 다시 섰다: n=%d err=%v", n.get(), err)
	}
	mu.Lock()
	fail = false
	mu.Unlock()
	clk.add(time.Second)
	if err := ask(svc); err != nil {
		t.Fatalf("백오프 뒤 = %v", err)
	}
}

// 실패 기억은 루트별이다 — 한 루트의 기동 실패가 다른 루트를 막지 않는다. TTL 60s 뒤엔
// 다시 시도한다.
func TestLifecycle_FailureMemoryPerRootAndTTL(t *testing.T) {
	var n int32Counter
	good, _, _ := killableStarter(t, nil)
	svc := svcWith(t, func(ctx context.Context, exe string, args []string, dir string) (io.ReadWriteCloser, func(), error) {
		n.inc()
		if dir == "/bad" {
			return nil, nil, errors.New("exec format error")
		}
		return good(ctx, exe, args, dir)
	}, map[string]string{"gopls": "/fake/gopls"})
	clk := &fakeClock{t: time.Now()}
	svc.Now = clk.now
	for i := 0; i < 2; i++ {
		if _, err := svc.Definition(context.Background(), "/bad", "/bad/a.go", "x", 1, 1); err == nil {
			t.Fatal("기동 실패인데 성공")
		}
	}
	if n.get() != 1 {
		t.Fatalf("실패를 기억하지 않았다: 기동 %d번", n.get())
	}
	if err := ask(svc); err != nil {
		t.Fatalf("다른 루트가 막혔다: %v", err)
	}
	clk.add(61 * time.Second)
	svc.Definition(context.Background(), "/bad", "/bad/a.go", "x", 1, 1)
	if n.get() != 3 {
		t.Fatalf("TTL 뒤 재시도가 없다: 기동 %d번", n.get())
	}
}

// lastUse 는 LSP 응답을 받은 요청(오류 응답 포함)에서만 는다 — 취소는 늘리지 않는다.
func TestLifecycle_LastUseOnlyOnResponse(t *testing.T) {
	start, _, _ := killableStarter(t, func(s *fakeServer, m map[string]any) {
		switch m["method"] {
		case "initialize":
			s.replyRaw(m["id"], map[string]any{})
		case "textDocument/hover":
			s.replyErrorRaw(m["id"], -32601, "no hover")
		case "textDocument/references":
			// 답하지 않는다 — 호출자는 ctx 로 빠진다
		}
	})
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})
	clk := &fakeClock{t: time.Now()}
	svc.Now = clk.now
	svc.Hover(context.Background(), "/root", "/root/a.go", "x", 1, 1)
	sess := svc.cachedSession("/root", ".go")
	if sess == nil {
		t.Fatal("세션이 없다")
	}
	clk.add(time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	svc.References(ctx, "/root", "/root/a.go", "x", 1, 1, false)
	if got := sess.LastUse(); !got.Before(clk.now()) {
		t.Fatal("취소된 요청이 lastUse 를 늘렸다")
	}
	svc.Hover(context.Background(), "/root", "/root/a.go", "x", 1, 1)
	if got := sess.LastUse(); !got.Equal(clk.now()) {
		t.Fatalf("오류 응답도 응답이다 — lastUse=%v want %v", got, clk.now())
	}
}

// 경로 표: 저장·검증·무효화·상태와 기동이 같은 표를 쓴다.
func TestPaths_SetValidatesPersistsAndInvalidates(t *testing.T) {
	start, _, n := killableStarter(t, nil)
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls", "typescript-language-server": "/fake/tsls"})
	file := filepath.Join(t.TempDir(), "lsp-paths.json")
	if err := svc.LoadPaths(file); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetPaths(map[string]string{"nope/nope": "/x"}); !errors.Is(err, ErrUnknownServer) {
		t.Fatalf("모르는 서술자 = %v", err)
	}
	if _, err := svc.SetPaths(map[string]string{"gopls/gopls": "rel/gopls"}); !errors.Is(err, ErrPathNotAbsolute) {
		t.Fatalf("상대경로 = %v", err)
	}
	// 두 서술자의 세션을 세운다.
	if err := ask(svc); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Definition(context.Background(), "/root", "/root/a.ts", "x", 1, 1); err != nil {
		t.Fatal(err)
	}
	abs := filepath.Join(t.TempDir(), "my-gopls")
	if err := os.WriteFile(abs, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := svc.SetPaths(map[string]string{"gopls/gopls": abs})
	if err != nil || got["gopls/gopls"] != abs {
		t.Fatalf("SetPaths = %v %v", got, err)
	}
	raw, _ := os.ReadFile(file)
	var onDisk struct{ Paths map[string]string }
	if json.Unmarshal(raw, &onDisk) != nil || onDisk.Paths["gopls/gopls"] != abs {
		t.Fatalf("파일 = %s", raw)
	}
	// 바뀐 서술자(gopls)의 세션만 정지 — ts 는 남는다.
	waitSessions(t, svc, 1)
	if svc.cachedSession("/root", ".ts") == nil {
		t.Fatal("바뀌지 않은 서술자의 세션까지 정지했다")
	}
	// 상태가 서버 표를 쓴다.
	sts, _ := svc.Status()
	for _, st := range sts {
		if st.ID == "gopls" && st.Exe != abs {
			t.Fatalf("상태가 서버 표를 쓰지 않았다: %+v", st)
		}
	}
	before := n.get()
	ask(svc) // 새 exe 로 다시 선다
	if n.get() != before+1 {
		t.Fatal("경로가 바뀐 뒤 새 세션을 세우지 않았다")
	}
	// 다시 읽어도 같다.
	svc2 := svcWith(t, start, nil)
	if err := svc2.LoadPaths(file); err != nil || svc2.Paths()["gopls/gopls"] != abs {
		t.Fatalf("LoadPaths = %v %v", svc2.Paths(), err)
	}
	// 빈 값은 삭제다.
	if got, err := svc.SetPaths(map[string]string{"gopls/gopls": ""}); err != nil || len(got) != 0 {
		t.Fatalf("삭제 = %v %v", got, err)
	}
}
