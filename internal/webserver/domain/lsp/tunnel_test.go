package lsp

import (
	"bufio"
	"context"
	"errors"
	"io"
	"path/filepath"
	"sort"
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

// §11.6 R: 경로 표에서 값이 바뀐 서술자의 통로를 닫는다 — 다음 연결이 새 실행 파일로 선다. 바뀌지 않은 것은 남는다.
func TestSetPaths_ClosesTunnelsOfChangedDesc(t *testing.T) {
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	gotn, err := svc.OpenTunnel(t.TempDir(), "gopls/gopls")
	if err != nil {
		t.Fatal(err)
	}
	ge := nextEnd(t, ends)
	if _, err := svc.SetPaths(map[string]string{"typescript/typescript-language-server": filepath.Join(t.TempDir(), "tsls")}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ge.stopped:
		t.Fatal("바뀌지 않은 서술자의 통로가 닫혔다")
	case <-time.After(100 * time.Millisecond):
	}
	if _, err := svc.SetPaths(map[string]string{"gopls/gopls": filepath.Join(t.TempDir(), "gopls")}); err != nil {
		t.Fatal(err)
	}
	waitStopped(t, ge, "경로가 바뀐 서술자의 통로가 닫히지 않았다")
	if _, err := gotn.Recv(); err == nil {
		t.Fatal("닫힌 통로가 읽힌다")
	}
}

// NFR-CMR-5: 통로를 열고 `initialize` 를 보내 응답을 받기까지의 서버 몫 (가짜 프로세스가 바로 답한다).
// WS 처리기의 몫은 httpapi 의 TestLSPWS_NFR5_HandlerShare 가 잰다 — 둘에 절반씩 둔다.
func TestTunnel_NFR5(t *testing.T) {
	const runs = 20
	const budget = 25 * time.Millisecond
	initMsg := []byte(`{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}`)
	reply := []byte(`{"jsonrpc":"2.0","id":0,"result":{"capabilities":{}}}`)
	start, ends, _ := pipeStarter(t)
	svc := goTunnelSvc(t, start)
	var took []time.Duration
	for i := 0; i < runs; i++ {
		go func() {
			e := <-ends
			if b, err := readFrame(e.in); err == nil && string(b) == string(initMsg) {
				_ = writeFrame(e.out, reply)
			}
		}()
		t0 := time.Now()
		tn, err := svc.OpenTunnel("/root", "gopls/gopls")
		if err != nil {
			t.Fatal(err)
		}
		if err := tn.Send(initMsg); err != nil {
			t.Fatal(err)
		}
		got, err := tn.Recv()
		if err != nil || string(got) != string(reply) {
			t.Fatalf("Recv=%q err=%v", got, err)
		}
		took = append(took, time.Since(t0))
		tn.Close()
	}
	sort.Slice(took, func(a, b int) bool { return took[a] < took[b] })
	med := took[runs/2]
	t.Logf("NFR-CMR-5 통로 몫 중앙값 %v (최소 %v · 최대 %v, %d회)", med, took[0], took[runs-1], runs)
	if med > budget {
		t.Fatalf("통로 몫 중앙값 %v > %v", med, budget)
	}
}
