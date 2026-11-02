package lsp

import (
	"bufio"
	"context"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

// pipeEnd 는 가짜 언어 서버 쪽 끝이다 — 통로가 stdin 에 쓴 것을 읽고, stdout 으로 쓴다.
type pipeEnd struct {
	in      *bufio.Reader
	out     *io.PipeWriter
	stopped chan struct{}
}

// pipeStarter 는 띄울 때마다 서버 쪽 끝을 ends 로 낸다. 띄운 횟수도 센다.
func pipeStarter(t *testing.T) (Starter, chan *pipeEnd, *int32Counter) {
	t.Helper()
	ends := make(chan *pipeEnd, 16)
	n := &int32Counter{}
	return func(_ context.Context, _ string, _ []string, _ string) (io.ReadWriteCloser, func(), error) {
		n.inc()
		cr, sw := io.Pipe()
		sr, cw := io.Pipe()
		e := &pipeEnd{in: bufio.NewReader(sr), out: sw, stopped: make(chan struct{})}
		var once sync.Once
		stop := func() {
			once.Do(func() {
				cw.Close()
				cr.Close()
				sw.Close()
				close(e.stopped)
			})
		}
		ends <- e
		return rwc{Reader: cr, Writer: cw, closeFn: func() error { cw.Close(); return cr.Close() }}, stop, nil
	}, ends, n
}

func nextEnd(t *testing.T, ends chan *pipeEnd) *pipeEnd {
	t.Helper()
	select {
	case e := <-ends:
		return e
	case <-time.After(2 * time.Second):
		t.Fatal("프로세스가 서지 않았다")
		return nil
	}
}

func waitStopped(t *testing.T, e *pipeEnd, why string) {
	t.Helper()
	select {
	case <-e.stopped:
	case <-time.After(2 * time.Second):
		t.Fatal(why)
	}
}

func goTunnelSvc(t *testing.T, start Starter) *Service {
	t.Helper()
	return svcWith(t, start, map[string]string{"gopls": "/fake/gopls"})
}

// FR-CMR-101: 브라우저 → 서버는 머리를 붙여 stdin 에, stdout → 브라우저는 머리를 뗀다.
// 길이는 바이트다 — 한글 본문으로 잰다.
func TestTunnel_FramesBothWays(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	tn, err := svc.OpenTunnel("/root", "gopls/gopls")
	if err != nil {
		t.Fatal(err)
	}
	e := nextEnd(t, ends)

	body := []byte(`{"jsonrpc":"2.0","method":"x","params":"한글"}`)
	go func() { _ = tn.Send(body) }()
	got, err := readFrame(e.in)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(body) {
		t.Fatalf("stdin 에 %q, 원래 %q", got, body)
	}

	back := []byte(`{"jsonrpc":"2.0","id":1,"result":"값"}`)
	go func() { _ = writeFrame(e.out, back) }()
	got, err = tn.Recv()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(back) {
		t.Fatalf("Recv=%q want %q", got, back)
	}
}

// FR-CMR-101: 여러 메시지가 한 번에 와도 경계가 맞다.
func TestTunnel_RecvSplitsCoalescedFrames(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	tn, err := svc.OpenTunnel("/root", "gopls/gopls")
	if err != nil {
		t.Fatal(err)
	}
	e := nextEnd(t, ends)
	a, b := `{"a":"가"}`, `{"b":2}`
	raw := "Content-Length: " + itoa(len(a)) + "\r\n\r\n" + a + "Content-Length: " + itoa(len(b)) + "\r\n\r\n" + b
	go func() { _, _ = e.out.Write([]byte(raw)) }()
	for _, want := range []string{a, b} {
		got, err := tn.Recv()
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != want {
			t.Fatalf("Recv=%q want %q", got, want)
		}
	}
}

// FR-CMR-103: 통로를 닫으면 프로세스가 끝나고, 프로세스가 끝나면 Recv 가 오류다.
func TestTunnel_CloseStopsProcess(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	tn, err := svc.OpenTunnel("/root", "gopls/gopls")
	if err != nil {
		t.Fatal(err)
	}
	e := nextEnd(t, ends)
	tn.Close()
	tn.Close() // 두 번 불러도 된다
	waitStopped(t, e, "Close 뒤에도 프로세스가 남았다")
	if _, err := tn.Recv(); err == nil {
		t.Fatal("닫힌 통로의 Recv 가 오류가 아니다")
	}
}

func TestTunnel_ProcessExitEndsRecv(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	tn, err := svc.OpenTunnel("/root", "gopls/gopls")
	if err != nil {
		t.Fatal(err)
	}
	e := nextEnd(t, ends)
	e.out.Close()
	if _, err := tn.Recv(); err == nil {
		t.Fatal("프로세스 stdout 이 닫혔는데 Recv 가 오류가 아니다")
	}
}

// FR-CMR-102: 통로 수가 상한이면 프로세스를 띄우지 않고 ErrLimit. 닫으면 자리가 난다.
func TestTunnel_LimitRejectsWithoutStarting(t *testing.T) {
	start, ends, n := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	svc.MaxSessions = 2
	var open []Tunnel
	for i := 0; i < 2; i++ {
		tn, err := svc.OpenTunnel("/root", "gopls/gopls")
		if err != nil {
			t.Fatal(err)
		}
		nextEnd(t, ends)
		open = append(open, tn)
	}
	if _, err := svc.OpenTunnel("/root", "gopls/gopls"); !errors.Is(err, ErrLimit) {
		t.Fatalf("err=%v want ErrLimit", err)
	}
	if n.get() != 2 {
		t.Fatalf("거절된 통로가 프로세스를 띄웠다: %d", n.get())
	}
	open[0].Close()
	if _, err := svc.OpenTunnel("/root", "gopls/gopls"); err != nil {
		t.Fatalf("닫은 뒤에도 자리가 나지 않았다: %v", err)
	}
}

// FR-CMR-102: REST 세션은 통로를 빼앗지 못한다 — 통로가 상한을 채우면 REST 가 거절된다.
func TestTunnel_RESTCannotEvictTunnel(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	svc.MaxSessions = 1
	tn, err := svc.OpenTunnel("/root", "gopls/gopls")
	if err != nil {
		t.Fatal(err)
	}
	e := nextEnd(t, ends)
	_, err = svc.Definition(context.Background(), "/root", Doc{Path: "/root/a.go", Text: "x\n"}, 1, 1)
	if !errors.Is(err, ErrLimit) {
		t.Fatalf("err=%v want ErrLimit", err)
	}
	select {
	case <-e.stopped:
		t.Fatal("REST 요청이 통로의 프로세스를 정지했다")
	default:
	}
	_ = tn
}

// FR-CMR-102: 상한은 REST 와 합쳐 센다. 통로가 서면 REST 세션이 LRU 로 정지된다.
func TestTunnel_OpenEvictsRESTSession(t *testing.T) {
	start, ends, _ := countingPipe(t)
	svc := goTunnelSvc(t, start)
	svc.MaxSessions = 1
	if _, err := svc.Definition(context.Background(), "/root", Doc{Path: "/root/a.go", Text: "x\n"}, 1, 1); err != nil {
		t.Fatal(err)
	}
	if svc.SessionCount() != 1 {
		t.Fatalf("REST 세션 수 %d", svc.SessionCount())
	}
	if _, err := svc.OpenTunnel("/root", "gopls/gopls"); err != nil {
		t.Fatal(err)
	}
	nextEnd(t, ends)
	if svc.SessionCount() != 0 {
		t.Fatalf("상한을 넘었는데 REST 세션이 남았다: %d", svc.SessionCount())
	}
}

// countingPipe 는 첫 기동(REST 세션)은 응답하는 가짜로, 그 뒤는 pipeStarter 로 띄운다.
func countingPipe(t *testing.T) (Starter, chan *pipeEnd, *int32Counter) {
	t.Helper()
	rest, _ := fakeStarter(t, echoHandler)
	pipe, ends, n := pipeStarter(t)
	first := true
	var mu sync.Mutex
	return func(ctx context.Context, exe string, args []string, dir string) (io.ReadWriteCloser, func(), error) {
		mu.Lock()
		f := first
		first = false
		mu.Unlock()
		if f {
			return rest(ctx, exe, args, dir)
		}
		return pipe(ctx, exe, args, dir)
	}, ends, n
}

// FR-CMR-102: 프레임이 오가면 LastUse 가 오른다. 프레임 없이 IdleAfter 가 지나면 Sweep 이 닫는다.
func TestTunnel_IdleSweep(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	now := time.Unix(1000, 0)
	var mu sync.Mutex
	svc.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	advance := func(d time.Duration) { mu.Lock(); now = now.Add(d); mu.Unlock() }
	svc.IdleAfter = time.Minute

	tn, err := svc.OpenTunnel("/root", "gopls/gopls")
	if err != nil {
		t.Fatal(err)
	}
	e := nextEnd(t, ends)
	go func() {
		for {
			if _, err := readFrame(e.in); err != nil {
				return
			}
		}
	}()

	advance(50 * time.Second)
	if err := tn.Send([]byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	advance(50 * time.Second)
	go func() { _ = writeFrame(e.out, []byte(`{}`)) }()
	if _, err := tn.Recv(); err != nil {
		t.Fatal(err)
	}
	advance(50 * time.Second)
	svc.Sweep()
	select {
	case <-e.stopped:
		t.Fatal("프레임이 오간 통로를 Sweep 이 닫았다")
	default:
	}
	if got := tn.LastUse(); !got.Equal(time.Unix(1100, 0)) {
		t.Fatalf("LastUse=%v — 마지막 프레임 시각이 아니다", got)
	}

	advance(2 * time.Minute)
	svc.Sweep()
	waitStopped(t, e, "유휴 통로를 Sweep 이 닫지 않았다")
	if _, err := svc.OpenTunnel("/root", "gopls/gopls"); err != nil {
		t.Fatalf("정리된 통로의 자리가 나지 않았다: %v", err)
	}
}

func TestTunnel_ShutdownClosesTunnels(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	if _, err := svc.OpenTunnel("/root", "gopls/gopls"); err != nil {
		t.Fatal(err)
	}
	e := nextEnd(t, ends)
	svc.Shutdown()
	waitStopped(t, e, "Shutdown 뒤에도 통로 프로세스가 남았다")
}

// 모르는 서술자, 실행 파일 없음은 상한과 다른 오류이고 프로세스를 띄우지 않는다.
func TestTunnel_UnknownOrMissingServer(t *testing.T) {
	start, _, n := pipeStarter(t)
	svc := svcWith(t, start, map[string]string{})
	for _, id := range []string{"nope/nope", "gopls/gopls", ""} {
		_, err := svc.OpenTunnel("/root", id)
		if err == nil || errors.Is(err, ErrLimit) {
			t.Fatalf("%q: err=%v", id, err)
		}
	}
	if n.get() != 0 {
		t.Fatalf("프로세스가 %d 번 섰다", n.get())
	}
	if _, err := svc.OpenTunnel("", "gopls/gopls"); err == nil {
		t.Fatal("루트 없이 통로가 열렸다")
	}
}
