package lsp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// countingStarter 는 프로세스가 **몇 번 섰는지** 센다. 그것이 lazy·재사용·실패
// 기억을 재는 유일한 방법이다.
func countingStarter(t *testing.T, handle func(*fakeServer, map[string]any)) (Starter, *int32Counter) {
	t.Helper()
	n := &int32Counter{}
	base, _ := fakeStarter(t, handle)
	return func(ctx context.Context, exe string, args []string, dir string) (io.ReadWriteCloser, func(), error) {
		n.inc()
		return base(ctx, exe, args, dir)
	}, n
}

type int32Counter struct {
	mu sync.Mutex
	n  int
}

func (c *int32Counter) inc() {
	c.mu.Lock()
	c.n++
	c.mu.Unlock()
}
func (c *int32Counter) get() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

func echoHandler(s *fakeServer, m map[string]any) {
	switch m["method"] {
	case "initialize":
		s.replyRaw(m["id"], map[string]any{})
	case "textDocument/definition", "textDocument/references":
		s.replyRaw(m["id"], []any{})
	}
}

func svcWith(t *testing.T, start Starter, onPath map[string]string) *Service {
	t.Helper()
	svc := &Service{
		Dir:   t.TempDir(),
		Start: start,
		LookPath: func(name string) (string, error) {
			if p, ok := onPath[name]; ok {
				return p, nil
			}
			return "", errors.New("not found")
		},
	}
	t.Cleanup(svc.Shutdown)
	return svc
}

// TC-LSP-70 (FR-LSP-13·14): 세션은 (루트, 서술자)마다 하나이며 **필요할 때** 선다.
// 같은 루트의 두 `.go` 파일이 한 프로세스를 공유한다.
func TestManager_OneSessionPerRootAndDescriptor(t *testing.T) {
	start, n := countingStarter(t, echoHandler)
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})

	if n.get() != 0 {
		t.Fatal("아무도 묻지 않았는데 프로세스가 섰다 — lazy 가 아니다")
	}
	for _, p := range []string{"/root/a.go", "/root/b.go"} {
		if _, err := svc.Definition(context.Background(), "/root", p, "x\n", 1, 1); err != nil {
			t.Fatal(err)
		}
	}
	if n.get() != 1 {
		t.Fatalf("프로세스가 %d 번 섰다 — 한 번이어야 한다", n.get())
	}
	// 다른 루트는 다른 세션이다.
	if _, err := svc.Definition(context.Background(), "/other", "/other/a.go", "x\n", 1, 1); err != nil {
		t.Fatal(err)
	}
	if n.get() != 2 {
		t.Fatalf("다른 루트가 세션을 공유했다: %d", n.get())
	}
}

// TC-LSP-71 (FR-LSP-13 / V-LSP-1b): `.ts` 와 `.js` 는 **같은 세션**이다. 언어를
// 단위로 삼으면 같은 프로세스가 두 번 뜬다.
func TestManager_TSAndJSShareASession(t *testing.T) {
	start, n := countingStarter(t, echoHandler)
	svc := svcWith(t, start, map[string]string{"typescript-language-server": "/fake/tsls"})

	for _, p := range []string{"/root/a.ts", "/root/b.js", "/root/c.tsx"} {
		if _, err := svc.Definition(context.Background(), "/root", p, "x\n", 1, 1); err != nil {
			t.Fatalf("%s: %v", p, err)
		}
	}
	if n.get() != 1 {
		t.Fatalf("프로세스가 %d 번 섰다 — TS·JS 는 한 서버를 공유한다", n.get())
	}
}

// TC-LSP-72 (FR-LSP-1 / V-LSP-1): 서술자에 없는 확장자는 세션을 세우지 않는다.
func TestManager_UnknownExtStartsNothing(t *testing.T) {
	start, n := countingStarter(t, echoHandler)
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})

	_, err := svc.Definition(context.Background(), "/root", "/root/notes.txt", "x\n", 1, 1)
	if err == nil {
		t.Fatal("모르는 확장자에 성공했다")
	}
	if n.get() != 0 {
		t.Fatal("모르는 확장자에 프로세스가 섰다")
	}
}

// TC-LSP-73 (FR-LSP-6·28 / D-9): 서버 실행 파일이 없으면 **그 사실을 사유로** 낸다.
// 침묵은 고장과 구별되지 않는다.
func TestManager_MissingServerSaysSo(t *testing.T) {
	start, n := countingStarter(t, echoHandler)
	svc := svcWith(t, start, nil) // PATH 에 아무것도 없다

	_, err := svc.Definition(context.Background(), "/root", "/root/a.go", "x\n", 1, 1)
	if err == nil {
		t.Fatal("서버가 없는데 성공했다")
	}
	if !strings.Contains(err.Error(), "gopls") {
		t.Fatalf("무엇이 없는지가 사유에 없다: %v", err)
	}
	if n.get() != 0 {
		t.Fatal("없는 실행 파일로 프로세스를 띄웠다")
	}
}

// TC-LSP-74 (FR-LSP-16 / V-LSP-8): 기동 실패는 **기억된다.** 매 요청마다 같은
// 실패를 되풀이해 프로세스를 띄우지 않는다.
func TestManager_RemembersStartFailure(t *testing.T) {
	var n int32Counter
	svc := svcWith(t, func(context.Context, string, []string, string) (io.ReadWriteCloser, func(), error) {
		n.inc()
		return nil, nil, errors.New("exec format error")
	}, map[string]string{"gopls": "/fake/gopls"})

	for i := 0; i < 3; i++ {
		if _, err := svc.Definition(context.Background(), "/root", "/root/a.go", "x\n", 1, 1); err == nil {
			t.Fatal("기동이 실패했는데 성공했다")
		}
	}
	if n.get() != 1 {
		t.Fatalf("기동을 %d 번 시도했다 — 실패는 기억되어야 한다", n.get())
	}
}

// TC-LSP-75 (FR-LSP-16): 설치가 바뀌면 그 기억은 지워진다 — 고쳐 놓고도 안 되면
// 사용자는 우리를 못 믿는다.
func TestManager_InstallClearsFailureMemory(t *testing.T) {
	var n int32Counter
	svc := svcWith(t, func(context.Context, string, []string, string) (io.ReadWriteCloser, func(), error) {
		n.inc()
		return nil, nil, errors.New("exec format error")
	}, map[string]string{"gopls": "/fake/gopls", "go": "/fake/go"})

	svc.Definition(context.Background(), "/root", "/root/a.go", "x\n", 1, 1)
	if n.get() != 1 {
		t.Fatalf("기동 시도가 %d 번", n.get())
	}
	// 설치를 시도하면(성공이든 실패든) 기억을 지운다.
	svc.Exec = func(context.Context, string, []string, []string, string) ([]byte, error) { return nil, nil }
	svc.Install(context.Background(), "gopls")

	svc.Definition(context.Background(), "/root", "/root/a.go", "x\n", 1, 1)
	if n.get() != 2 {
		t.Fatalf("설치 뒤에도 기억이 남았다: 기동 시도 %d 번", n.get())
	}
}

// TC-LSP-76 (FR-LSP-17 / V-LSP-9): 쓰이지 않은 세션은 정지한다. 언어 서버는 큰
// 저장소에서 수백 MB 를 쓴다.
func TestManager_SweepStopsIdle(t *testing.T) {
	start, n := countingStarter(t, echoHandler)
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})
	svc.IdleAfter = 1 * time.Millisecond

	if _, err := svc.Definition(context.Background(), "/root", "/root/a.go", "x\n", 1, 1); err != nil {
		t.Fatal(err)
	}
	if svc.SessionCount() != 1 {
		t.Fatalf("세션이 서지 않았다: %d", svc.SessionCount())
	}
	time.Sleep(20 * time.Millisecond)
	svc.Sweep()
	if svc.SessionCount() != 0 {
		t.Fatalf("idle 세션이 정지하지 않았다: %d", svc.SessionCount())
	}
	// 다시 물으면 다시 선다 — 정지는 포기가 아니다.
	if _, err := svc.Definition(context.Background(), "/root", "/root/a.go", "x\n", 1, 1); err != nil {
		t.Fatal(err)
	}
	if n.get() != 2 {
		t.Fatalf("정지한 세션이 다시 서지 않았다: %d", n.get())
	}
}

// TC-LSP-77 (FR-LSP-19): 세션 수에 상한이 있고, 넘으면 가장 오래 쓰이지 않은
// 것을 정지한다.
func TestManager_EvictsOldestOverLimit(t *testing.T) {
	start, _ := countingStarter(t, echoHandler)
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})
	svc.MaxSessions = 2

	for _, root := range []string{"/r1", "/r2", "/r3"} {
		if _, err := svc.Definition(context.Background(), root, root+"/a.go", "x\n", 1, 1); err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond) // lastUse 를 벌린다
	}
	if got := svc.SessionCount(); got > 2 {
		t.Fatalf("상한을 넘겼다: %d", got)
	}
}

// TC-LSP-78 (FR-LSP-18 / V-LSP-9): 서버가 내려갈 때 모든 세션이 정지한다.
func TestManager_ShutdownStopsAll(t *testing.T) {
	start, _ := countingStarter(t, echoHandler)
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})

	for _, root := range []string{"/r1", "/r2"} {
		if _, err := svc.Definition(context.Background(), root, root+"/a.go", "x\n", 1, 1); err != nil {
			t.Fatal(err)
		}
	}
	if svc.SessionCount() != 2 {
		t.Fatalf("세션이 둘이 아니다: %d", svc.SessionCount())
	}
	svc.Shutdown()
	if svc.SessionCount() != 0 {
		t.Fatalf("Shutdown 뒤에도 세션이 남았다: %d", svc.SessionCount())
	}
}

// TC-LSP-79 (FR-LSP-24·49): 루트 밖의 경로는 거절된다. 가드가 종단에도 있지만
// 여기서도 막는 이유는, 이 표면을 다른 종단이 쓰게 될 때 그 가드를 다시 적지
// 않도록 하기 위해서다.
func TestManager_RejectsPathOutsideRoot(t *testing.T) {
	start, n := countingStarter(t, echoHandler)
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})

	for _, p := range []string{"/elsewhere/a.go", "/root/../etc/a.go"} {
		if _, err := svc.Definition(context.Background(), "/root", p, "x\n", 1, 1); err == nil {
			t.Fatalf("%s 가 통과했다 — 루트 밖이다", p)
		}
	}
	if n.get() != 0 {
		t.Fatal("루트 밖 경로로 프로세스를 띄웠다")
	}
}

// TC-LSP-80 (FR-LSP-53): 텍스트 크기에 상한이 있다.
func TestManager_RejectsHugeText(t *testing.T) {
	start, _ := countingStarter(t, echoHandler)
	svc := svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})

	huge := strings.Repeat("x", MaxTextBytes+1)
	if _, err := svc.Definition(context.Background(), "/root", "/root/a.go", huge, 1, 1); err == nil {
		t.Fatal("상한을 넘긴 텍스트가 통과했다")
	}
}

var _ = json.Marshal
