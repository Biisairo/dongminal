package lsp

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-6-1·6-2·6-3 — 계수 검사다. 언어 서버로 나간 동기화
// 알림과 자리 요청, 프로세스 기동의 **횟수**를 센다.

// count 는 recorder 가 받은 알림·요청을 method 별로 센다.
func (r *recorder) count(method string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, m := range r.msgs {
		if m["method"] == method {
			n++
		}
	}
	return n
}

func recSession(t *testing.T) (*Session, *recorder) {
	t.Helper()
	rec := &recorder{}
	start, _ := fakeStarter(t, func(s *fakeServer, m map[string]any) {
		rec.handle(s, m)
		if m["method"] == "textDocument/hover" {
			s.replyRaw(m["id"], map[string]any{"contents": "h"})
		}
	})
	sess := newSession(tRoot(), mustDesc(t, ".go"), "/fake/gopls", start, nil)
	t.Cleanup(sess.Close)
	return sess, rec
}

// FR-OPT-6-1 (DOM-1): 내용이 같으면 didChange 를 보내지 않는다. 다르면 보낸다.
func TestSync_SameTextSkipsDidChange(t *testing.T) {
	sess, rec := recSession(t)
	ctx := context.Background()
	for _, text := range []string{"a\n", "a\n", "a\n", "b\n", "b\n"} {
		if _, err := sess.Definition(ctx, Doc{Path: tFile("a.go"), Text: text}, 1, 1); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := sess.Hover(ctx, Doc{Path: tFile("a.go"), Text: "b\n"}, 1, 1); err != nil {
		t.Fatal(err)
	}
	if n := rec.count("textDocument/didOpen"); n != 1 {
		t.Fatalf("didOpen %d 번 — 한 번이어야 한다", n)
	}
	// 요청 6, 내용 변화 1 → didChange 1 (이전 동작: 5).
	if n := rec.count("textDocument/didChange"); n != 1 {
		t.Fatalf("didChange %d 번 — 내용이 바뀐 한 번이어야 한다", n)
	}
	if n := rec.count("textDocument/definition"); n != 5 {
		t.Fatalf("definition %d 번 — 요청마다 물어야 한다", n)
	}
}

// FR-OPT-6-2: 텍스트를 뺀 요청은 세션이 그 판을 받았을 때만 통과한다. 모르는 판이면
// ErrNeedText 이고 언어 서버에 묻지 않는다.
func TestSync_NoTextNeedsKnownVersion(t *testing.T) {
	sess, rec := recSession(t)
	ctx := context.Background()
	p := tFile("a.go")

	// 한 번도 받지 않은 문서.
	if _, err := sess.Definition(ctx, Doc{Path: p, Version: "v1", NoText: true}, 1, 1); !errors.Is(err, ErrNeedText) {
		t.Fatalf("모르는 문서 = %v, ErrNeedText 여야 한다", err)
	}
	if _, err := sess.Definition(ctx, Doc{Path: p, Text: "a\n", Version: "v1"}, 1, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := sess.Hover(ctx, Doc{Path: p, Version: "v1", NoText: true}, 1, 1); err != nil {
		t.Fatalf("받은 판 = %v", err)
	}
	if _, err := sess.Definition(ctx, Doc{Path: p, Version: "v2", NoText: true}, 1, 1); !errors.Is(err, ErrNeedText) {
		t.Fatalf("다른 판 = %v", err)
	}
	// 판 없는 생략은 통과하지 않는다.
	if _, err := sess.Definition(ctx, Doc{Path: p, NoText: true}, 1, 1); !errors.Is(err, ErrNeedText) {
		t.Fatalf("판 없는 생략 = %v", err)
	}
	// 같은 내용을 새 판으로 실으면 didChange 없이 판만 바뀐다.
	if _, err := sess.Definition(ctx, Doc{Path: p, Text: "a\n", Version: "v3"}, 1, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := sess.Definition(ctx, Doc{Path: p, Version: "v1", NoText: true}, 1, 1); !errors.Is(err, ErrNeedText) {
		t.Fatalf("지나간 판 = %v", err)
	}
	if _, err := sess.Definition(ctx, Doc{Path: p, Version: "v3", NoText: true}, 1, 1); err != nil {
		t.Fatalf("새 판 = %v", err)
	}
	if n := rec.count("textDocument/didChange"); n != 0 {
		t.Fatalf("didChange %d 번 — 내용이 같았다", n)
	}
	if n := rec.count("textDocument/definition") + rec.count("textDocument/hover"); n != 4 {
		t.Fatalf("자리 요청 %d 번 — 모르는 판에는 묻지 않아야 한다 (4)", n)
	}
}

// FR-OPT-6-2: 디스크 재동기화가 내용을 바꾸면 브라우저의 판은 더 이상 서버의 것이
// 아니다. 닫힌 문서도 같다.
func TestSync_ResyncAndCloseForgetVersion(t *testing.T) {
	svc, _ := docSvc(t)
	root, p := docRoot(t)
	ctx := context.Background()
	noText := Doc{Path: p, Version: "v1", NoText: true}

	if _, err := svc.Definition(ctx, root, Doc{Path: p, Text: "package a\n", Version: "v1"}, 1, 1); err != nil {
		t.Fatal(err)
	}
	// 디스크가 같으면 판을 잃지 않는다.
	svc.ResyncPath(p)
	if _, err := svc.Definition(ctx, root, noText, 1, 1); err != nil {
		t.Fatalf("디스크가 같은데 판을 잃었다: %v", err)
	}
	if err := os.WriteFile(p, []byte("package b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc.ResyncPath(p)
	if _, err := svc.Definition(ctx, root, noText, 1, 1); !errors.Is(err, ErrNeedText) {
		t.Fatalf("디스크 판으로 바뀐 뒤 = %v, ErrNeedText 여야 한다", err)
	}
	if _, err := svc.Definition(ctx, root, Doc{Path: p, Text: "package a\n", Version: "v1"}, 1, 1); err != nil {
		t.Fatal(err)
	}
	svc.CloseDoc(root, p)
	if _, err := svc.Definition(ctx, root, noText, 1, 1); !errors.Is(err, ErrNeedText) {
		t.Fatalf("닫힌 뒤 = %v", err)
	}
}

// gatedStarter 는 release 가 닫힐 때까지 기동을 붙든다 — 동시 미스가 겹치게 한다.
func gatedStarter(t *testing.T, fail bool) (Starter, *atomic.Int32, chan struct{}) {
	t.Helper()
	var n atomic.Int32
	release := make(chan struct{})
	base, _ := fakeStarter(t, echoHandler)
	return func(ctx context.Context, exe string, args []string, dir string) (io.ReadWriteCloser, func(), error) {
		n.Add(1)
		<-release
		if fail {
			return nil, nil, errors.New("boom")
		}
		return base(ctx, exe, args, dir)
	}, &n, release
}

// FR-OPT-6-3 (DOM-9): 같은 키에 동시에 온 요청들이 언어 서버를 한 번만 띄운다.
func TestManager_SingleFlightStart(t *testing.T) {
	for _, fail := range []bool{false, true} {
		start, n, release := gatedStarter(t, fail)
		svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})
		const callers = 8
		var wg sync.WaitGroup
		errs := make(chan error, callers)
		for i := 0; i < callers; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, err := svc.Definition(context.Background(), "/root", Doc{Path: "/root/a.go", Text: "x"}, 1, 1)
				errs <- err
			}()
		}
		// 모두가 미스를 볼 시간을 준다 — 이전 동작이면 그동안 전부 기동에 들어간다.
		deadline := time.Now().Add(time.Second)
		for n.Load() == 0 && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		time.Sleep(100 * time.Millisecond)
		close(release)
		wg.Wait()
		close(errs)
		if got := n.Load(); got != 1 {
			t.Fatalf("fail=%v: 기동 %d 번 — 한 번이어야 한다", fail, got)
		}
		for err := range errs {
			if fail != (err != nil) {
				t.Fatalf("fail=%v: err=%v", fail, err)
			}
		}
		if !fail && svc.SessionCount() != 1 {
			t.Fatalf("세션 %d 개", svc.SessionCount())
		}
	}
}

// FR-OPT-6-3 (DOM-10): 상한을 넘은 텍스트는 언어 서버를 띄우기 전에 거절한다.
func TestManager_HugeTextStartsNothing(t *testing.T) {
	start, n := countingStarter(t, echoHandler)
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})
	huge := strings.Repeat("x", MaxTextBytes+1)
	if _, err := svc.Hover(context.Background(), "/root", Doc{Path: "/root/a.go", Text: huge}, 1, 1); err == nil {
		t.Fatal("상한을 넘긴 텍스트가 통과했다")
	}
	if n.get() != 0 {
		t.Fatalf("거절할 요청이 언어 서버를 %d 번 띄웠다", n.get())
	}
}
