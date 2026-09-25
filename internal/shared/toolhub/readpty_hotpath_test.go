package toolhub

import (
	"bytes"
	"math/rand"
	"testing"
	"time"
)

// OPTIMIZE_REFACTOR_SRS FR-OPT-3-2 (SHR-3 · SHR-4) — 청크 하나의 할당 수를 고정한다.
//
// 종전: 구독자 0 · 릴레이 없음 1회, 릴레이 2회, TUI 청크(모드 설정 포함)는 +1회.
func TestHandleChunk_Allocs(t *testing.T) {
	cases := []struct {
		name  string
		relay bool
		chunk []byte
		want  float64
	}{
		{"plain/no-clients", false, hotpathPlainChunk(), 0},
		{"plain/relay", true, hotpathPlainChunk(), 1},
		{"tui/no-clients", false, hotpathTUIChunk(), 0},
		{"tui/relay", true, hotpathTUIChunk(), 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := newHotpathTool(tc.relay)
			p.handleChunk(tc.chunk) // 스트림 링이 자라는 몫은 뺀다
			if got := testing.AllocsPerRun(50, func() { p.handleChunk(tc.chunk) }); got != tc.want {
				t.Fatalf("allocs/chunk=%v want %v", got, tc.want)
			}
		})
	}
}

// 경계에 걸친 시퀀스의 이월도 할당하지 않는다 — 이월과 청크를 잇는 버퍼는 재사용이다.
func TestHandleChunk_CarryJoinDoesNotAllocate(t *testing.T) {
	p := newHotpathTool(false)
	a := []byte("output \x1b]9;hel")
	b := []byte("lo\x07 more \x1b[?20")
	c := []byte("04h tail")
	feed := func() {
		p.handleChunk(a)
		p.handleChunk(b)
		p.handleChunk(c)
	}
	feed()
	if !p.BracketedPaste() {
		t.Fatal("경계에 걸친 ESC[?2004h 를 놓쳤다")
	}
	// 이월 자체의 사본(탐지기가 돌려주는 것)은 남는다: 주의 1 + 모드 1.
	if got := testing.AllocsPerRun(50, feed); got > 2 {
		t.Fatalf("allocs/3 chunks=%v want <= 2", got)
	}
}

// 릴레이가 받은 슬라이스는 이후 청크가 덮지 않는다 — 데몬의 push 큐가 그것을 보관한다.
func TestHandleChunk_RelayDataNotOverwritten(t *testing.T) {
	p := newHotpathTool(false)
	var got [][]byte
	p.relay.Store(&toolRelay{onOutput: func(_ string, d []byte, _ int64) { got = append(got, d) }})
	raw := []byte("first")
	p.handleChunk(raw)
	copy(raw, "XXXXX")
	p.handleChunk(raw)
	if string(got[0]) != "first" || string(got[1]) != "XXXXX" {
		t.Fatalf("relay data=%q %q", got[0], got[1])
	}
}

// 구독자가 없으면 OpOutput 프레임을 만들지 않는다 — 데몬 모드의 모든 청크가 그렇다.
func TestFeedAndDeliver_NoClientsNoFrame(t *testing.T) {
	p := newHotpathTool(false)
	if _, msg, _ := p.feedAndDeliver([]byte("x"), false); msg != nil {
		t.Fatalf("msg=%v want nil", msg)
	}
}

// FR-OPT-3-1 (SHR-2 · IPC-15) — 느린 브라우저 하나가 PTY 읽기 루프도, 같은 도구의
// 다른 클라이언트도 세우지 못한다. 넘친 연결은 닫히고 목록에서 빠진다.
func TestDeliver_SlowClientDoesNotBlockReadLoop(t *testing.T) {
	p := newHotpathTool(false)

	slowSrv, slowCli := wsPair(t) // slowCli 는 읽지 않는다
	_ = slowCli
	fastSrv, fastCli := wsPair(t)
	slow, fast := NewSafeConn(slowSrv), NewSafeConn(fastSrv)
	slow.StartSender()
	fast.StartSender()
	if !p.AddClient(slow) || !p.AddClient(fast) {
		t.Fatal("AddClient 가 거절했다")
	}

	chunk := bytes.Repeat([]byte("y"), 32<<10)
	const n = 2000 // 64 MB — 소켓 버퍼와 큐를 넉넉히 넘는다
	var received int
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		fastCli.SetReadDeadline(time.Now().Add(20 * time.Second))
		for received < n*len(chunk) {
			_, msg, err := fastCli.ReadMessage()
			if err != nil {
				return
			}
			received += len(msg) - 1
		}
	}()

	start := time.Now()
	for i := 0; i < n; i++ {
		p.handleChunk(chunk)
		// 빠른 쪽도 큐를 넘기면 닫힌다 — 읽기 루프의 속도를 소비자에 맞춘다.
		for fast.queueLen() > sendQueueCap/2 {
			time.Sleep(time.Millisecond)
		}
	}
	if d := time.Since(start); d > 15*time.Second {
		t.Fatalf("읽기 루프가 %v 걸렸다 — 느린 소켓에 막혔다", d)
	}
	<-readDone
	if received != n*len(chunk) {
		t.Fatalf("빠른 클라이언트가 %d/%d 바이트만 받았다", received, n*len(chunk))
	}
	p.cmu.Lock()
	cls := p.cls
	p.cmu.Unlock()
	if len(cls) != 1 || cls[0] != fast {
		t.Fatalf("넘친 연결이 목록에 남았다: %d 개", len(cls))
	}
	select {
	case <-slow.closed:
	default:
		t.Fatal("넘친 연결이 닫히지 않았다")
	}
}

// 송신 고루틴이 서기 전의 라이브 프레임은 큐에서 기다린다 — 동기 송신(재생·OpSeq)이
// 먼저 나가고, 그 뒤에 쌓인 순서대로 나간다 (FR-TRS-8).
func TestSafeConn_QueuedFramesFollowSyncSends(t *testing.T) {
	srv, cli := wsPair(t)
	sc := NewSafeConn(srv)
	defer sc.Close()
	if !sc.Enqueue([]byte{OpOutput, 'a'}) || !sc.Enqueue([]byte{OpOutput, 'b'}) {
		t.Fatal("Enqueue 거절")
	}
	if err := sc.Send(OpSeq, []byte{9}); err != nil {
		t.Fatal(err)
	}
	sc.StartSender()
	sc.StartSender() // 두 번 불러도 고루틴은 하나다
	want := [][]byte{{OpSeq, 9}, {OpOutput, 'a'}, {OpOutput, 'b'}}
	cli.SetReadDeadline(time.Now().Add(5 * time.Second))
	for i, w := range want {
		_, msg, err := cli.ReadMessage()
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if !bytes.Equal(msg, w) {
			t.Fatalf("frame %d=%v want %v", i, msg, w)
		}
	}
}

// 닫힌 연결의 Enqueue 는 false 이고 막히지 않는다.
func TestSafeConn_EnqueueAfterClose(t *testing.T) {
	srv, _ := wsPair(t)
	sc := NewSafeConn(srv)
	sc.Close()
	for i := 0; i < 2*sendQueueCap; i++ {
		if sc.Enqueue([]byte{OpOutput}) {
			t.Fatal("닫힌 연결이 받았다")
		}
	}
}

// kill 의 OpExit 은 이미 쌓인 출력 뒤에 나간다.
func TestKill_ExitFollowsQueuedOutput(t *testing.T) {
	p := newHotpathTool(false)
	srv, cli := wsPair(t)
	sc := NewSafeConn(srv)
	defer sc.Close()
	if !p.AddClient(sc) {
		t.Fatal("AddClient 거절")
	}
	p.handleChunk([]byte("last words"))
	p.kill()
	sc.StartSender()
	cli.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, m1, err := cli.ReadMessage()
	if err != nil || string(m1) != "\x00last words" {
		t.Fatalf("frame1=%q err=%v", m1, err)
	}
	_, m2, err := cli.ReadMessage()
	if err != nil || !bytes.Equal(m2, []byte{OpExit}) {
		t.Fatalf("frame2=%v err=%v", m2, err)
	}
}

// SHR-4: 탐지기를 IndexByte 로 건너뛰게 바꾼 뒤에도 결과는 종전(한 바이트씩)과 같다.
func refDetectAttentionSignal(b []byte, allowBell bool, maxCarry int) (bool, []byte) {
	i, n := 0, len(b)
	for i < n {
		c := b[i]
		switch {
		case c == 0x07:
			if allowBell {
				return true, nil
			}
			i++
		case c == 0x1b:
			if i+1 >= n {
				return false, boundedCarry(b[i:], maxCarry)
			}
			if b[i+1] == ']' {
				end, termLen := findOSCTerminator(b, i+2)
				if end < 0 {
					return false, boundedCarry(b[i:], maxCarry)
				}
				if isAttentionOSC(b[i+2 : end]) {
					return true, nil
				}
				i = end + termLen
			} else {
				i += 2
			}
		default:
			i++
		}
	}
	return false, nil
}

func refDetectCwdReport(b []byte) string {
	const marker = "777;Cwd;"
	out := ""
	i, n := 0, len(b)
	for i < n {
		if b[i] != 0x1b || i+1 >= n || b[i+1] != ']' {
			i++
			continue
		}
		end, termLen := findOSCTerminator(b, i+2)
		if end < 0 {
			break
		}
		body := b[i+2 : end]
		if bytes.HasPrefix(body, []byte(marker)) {
			if v := string(body[len(marker):]); v != "" {
				out = v
			}
		}
		i = end + termLen
	}
	return out
}

func TestDetectors_MatchByteWiseReference(t *testing.T) {
	alphabet := []string{"\x1b", "]", "\x07", "\\", "9;", "9;4;1", "99;", "777;notify;x", "777;Cwd;/tmp/a", "[", "?", "2004h", "a", "b", ";", "0"}
	rng := rand.New(rand.NewSource(7))
	for iter := 0; iter < 200000; iter++ {
		var b bytes.Buffer
		for k := rng.Intn(24); k > 0; k-- {
			b.WriteString(alphabet[rng.Intn(len(alphabet))])
		}
		in := b.Bytes()
		for _, bell := range []bool{false, true} {
			gs, gc := DetectAttentionSignal(in, bell, 8)
			ws, wc := refDetectAttentionSignal(in, bell, 8)
			if gs != ws || !bytes.Equal(gc, wc) || (gc == nil) != (wc == nil) {
				t.Fatalf("DetectAttentionSignal(%q,%v)=(%v,%q) want (%v,%q)", in, bell, gs, gc, ws, wc)
			}
		}
		if g, w := DetectCwdReport(in), refDetectCwdReport(in); g != w {
			t.Fatalf("DetectCwdReport(%q)=%q want %q", in, g, w)
		}
	}
}

// classifyEsc 가 "할 일 없음" 이라 하면 탐지기는 정말로 아무것도 찾지 못하고 이월도
// 남기지 않는다 — 건너뛰기가 결과를 바꾸지 않는다는 근거다 (SHR-4).
func TestClassifyEsc_SkipIsSound(t *testing.T) {
	alphabet := []string{"\x1b", "]", "\x07", "\\", "9;x", "777;Cwd;/a", "[", "?", "2004h", "1049l", "a", ";", "0", "m", "\x1b[0m", "\x1b[?"}
	rng := rand.New(rand.NewSource(11))
	for iter := 0; iter < 200000; iter++ {
		var b bytes.Buffer
		for k := rng.Intn(20); k > 0; k-- {
			b.WriteString(alphabet[rng.Intn(len(alphabet))])
		}
		in := b.Bytes()
		for _, bell := range []bool{false, true} {
			c := classifyEsc(in, bell)
			if !c.osc {
				if sig, carry := DetectAttentionSignal(in, bell, AttnMaxCarry); sig || carry != nil {
					t.Fatalf("osc=false 인데 탐지기가 (%v,%q) — %q bell=%v", sig, carry, in, bell)
				}
				if cwd := DetectCwdReport(in); cwd != "" {
					t.Fatalf("osc=false 인데 cwd=%q — %q", cwd, in)
				}
			}
			if !c.modes {
				cur := TermModes{MouseProtocol: 1000}
				if next, carry := scanModes(in, cur); next != cur || carry != nil {
					t.Fatalf("modes=false 인데 scanModes=(%+v,%q) — %q", next, carry, in)
				}
			}
		}
	}
}

// 청크를 읽는 사이에 다른 경로가 kill 해도 OpExit 은 마지막 프레임이다 — 늦은 출력
// 프레임이 OpExit 뒤에 큐에 들어가지 않는다. 릴레이 콜백은 목록 확보와 송신 사이에
// 불리므로 그 창에 kill 을 끼워 넣는다.
func TestHandleChunk_ConcurrentKillKeepsExitLast(t *testing.T) {
	p := newHotpathTool(false)
	p.relay.Store(&toolRelay{onOutput: func(string, []byte, int64) { p.kill() }})
	srv, cli := wsPair(t)
	sc := NewSafeConn(srv)
	defer sc.Close()
	if !p.AddClient(sc) {
		t.Fatal("AddClient 거절")
	}
	p.handleChunk([]byte("late"))
	sc.StartSender()
	cli.SetReadDeadline(time.Now().Add(5 * time.Second))
	var frames [][]byte
	for {
		_, m, err := cli.ReadMessage()
		if err != nil {
			t.Fatalf("frames=%q err=%v", frames, err)
		}
		frames = append(frames, m)
		if len(m) == 1 && m[0] == OpExit {
			break
		}
	}
	if len(frames) != 2 || string(frames[0]) != "\x00late" {
		t.Fatalf("frames=%q want [late, exit]", frames)
	}
}

// 송신 고루틴이 서기 전(동기 재생·OpSeq 창)에는 큐 상한을 넘어도 닫지 않고 잃지도
// 않는다 — 재생이 1 MB 를 보내는 동안 라이브 출력이 몰려도 재접속 고리에 들지 않는다.
func TestSafeConn_BacklogBeforeStartIsUnbounded(t *testing.T) {
	srv, cli := wsPair(t)
	sc := NewSafeConn(srv)
	defer sc.Close()
	const n = 4 * sendQueueCap
	for i := 0; i < n; i++ {
		if !sc.Enqueue([]byte{OpOutput, byte(i)}) {
			t.Fatalf("frame %d 거절 — 시작 전에 닫혔다", i)
		}
	}
	sc.StartSender()
	cli.SetReadDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < n; i++ {
		_, m, err := cli.ReadMessage()
		if err != nil {
			t.Fatalf("frame %d: %v", i, err)
		}
		if !bytes.Equal(m, []byte{OpOutput, byte(i)}) {
			t.Fatalf("frame %d=%v", i, m)
		}
	}
}
