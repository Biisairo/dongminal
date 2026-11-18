package toolhub

import (
	"bytes"
	"math/rand"
	"testing"
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

// 릴레이가 없으면 OpOutput 프레임을 만들지 않는다 (DIRECT_MODE_REMOVAL_SRS FR-DMR-41).
func TestFeedAndDeliver_NoClientsNoFrame(t *testing.T) {
	p := newHotpathTool(false)
	if _, msg := p.feedAndDeliver([]byte("x"), false); msg != nil {
		t.Fatalf("msg=%v want nil", msg)
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
