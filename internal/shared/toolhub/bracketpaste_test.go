package toolhub

import (
	"bytes"
	"testing"
)

// ── 모드 추적 (FR-BPT-1/2/5) ─────────────────────────────────────────

func TestBracketedPaste_DefaultsOff(t *testing.T) {
	// 켠 적 없는 셸에 감싸서 보내면 마커가 명령줄에 글자로 들어간다. 기본값이
	// 꺼짐인 것이 이 결함을 막는 첫 줄이다.
	var p Tool
	if p.BracketedPaste() {
		t.Fatal("초기값이 켜짐이다")
	}
}

func TestBracketedPaste_TracksEnableDisable(t *testing.T) {
	cases := []struct {
		name string
		feed []string
		want bool
	}{
		{"켜기", []string{"\x1b[?2004h"}, true},
		{"켜고 끄기", []string{"\x1b[?2004h", "\x1b[?2004l"}, false},
		{"끄고 켜기", []string{"\x1b[?2004l", "\x1b[?2004h"}, true},
		{"한 청크에 켜고 끄기 — 마지막이 이긴다", []string{"\x1b[?2004h잡음\x1b[?2004l"}, false},
		{"한 청크에 끄고 켜기", []string{"\x1b[?2004l잡음\x1b[?2004h"}, true},
		{"무관한 출력은 상태를 바꾸지 않는다", []string{"\x1b[?2004h", "hello\x1b[31m world"}, true},
		{"ESC 없는 출력", []string{"그냥 텍스트"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var p Tool
			for _, chunk := range c.feed {
				p.observeBracketedPaste([]byte(chunk))
			}
			if got := p.BracketedPaste(); got != c.want {
				t.Fatalf("got %v, want %v", got, c.want)
			}
		})
	}
}

// 시퀀스가 읽기 경계에 걸려 쪼개져도 놓치면 안 된다 (FR-BPT-3).
//
// 이것이 무너지면 모드가 켜졌는데 꺼진 것으로 오판하고, 여러 줄 입력이 줄마다
// 실행된다 — 조용히 잘못되는 쪽이라 더 나쁘다 (§6 R-1).
func TestBracketedPaste_SplitAcrossReads(t *testing.T) {
	for _, seq := range []string{"\x1b[?2004h", "\x1b[?2004l"} {
		for cut := 1; cut < len(seq); cut++ {
			var p Tool
			// 켜기를 먼저 확정해 두면 끄기 시퀀스의 쪼개짐도 검증된다.
			p.observeBracketedPaste([]byte("\x1b[?2004h"))
			p.observeBracketedPaste([]byte(seq[:cut]))
			p.observeBracketedPaste([]byte(seq[cut:]))
			want := seq == "\x1b[?2004h"
			if got := p.BracketedPaste(); got != want {
				t.Errorf("%q 를 %d 에서 자르면 %v (want %v)", seq, cut, got, want)
			}
		}
	}
}

func TestBracketedPaste_ByteAtATime(t *testing.T) {
	var p Tool
	for _, b := range []byte("앞\x1b[?2004h뒤") {
		p.observeBracketedPaste([]byte{b})
	}
	if !p.BracketedPaste() {
		t.Fatal("1바이트씩 먹였더니 켜기를 놓쳤다")
	}
}

// 이월에 상한이 없으면 ESC 로 시작해 끝나지 않는 출력이 메모리를 먹는다.
func TestBracketedPaste_CarryIsBounded(t *testing.T) {
	var p Tool
	for i := 0; i < 1000; i++ {
		p.observeBracketedPaste([]byte("\x1b"))
	}
	if len(p.bpCarryBuf) > bpMaxCarry {
		t.Fatalf("이월이 %d 바이트까지 자랐다 (상한 %d)", len(p.bpCarryBuf), bpMaxCarry)
	}
}

// 접두사가 될 수 없는 꼬리는 들고 가지 않는다.
func TestBracketedPaste_DropsImpossibleCarry(t *testing.T) {
	var p Tool
	p.observeBracketedPaste([]byte("\x1b[31m"))
	if len(p.bpCarryBuf) != 0 {
		t.Fatalf("색상 시퀀스를 이월했다: %q", p.bpCarryBuf)
	}
}

// ── 감싸기 (FR-BPW-2) ────────────────────────────────────────────────

func TestWrapPaste(t *testing.T) {
	text := []byte("echo hi")

	off := wrapPaste(text, false)
	if !bytes.Equal(off, text) {
		t.Fatalf("모드가 꺼졌는데 감쌌다: %q", off)
	}

	// 기대값을 **리터럴로** 적는다. 구현의 상수를 그대로 가져오면 상수가
	// 틀렸을 때 테스트도 함께 틀린다 — 실제로 그렇게 놓쳤다: 감싸기에 모드
	// 신호(ESC[?2004h)를 넣었는데 테스트가 같은 상수로 대조해 통과했다.
	on := wrapPaste(text, true)
	want := []byte("\x1b[200~echo hi\x1b[201~")
	if !bytes.Equal(on, want) {
		t.Fatalf("got %q, want %q", on, want)
	}
}

// 감싸지 않은 결과에 마커가 섞여 있으면 안 된다 — 그것이 이 결함의 증상이었다
// (bash: 200~echo: command not found).
func TestWrapPaste_OffLeavesNoMarkers(t *testing.T) {
	out := wrapPaste([]byte("echo dongminal-e2e-ok"), false)
	for _, marker := range [][]byte{[]byte("200~"), []byte("201~"), []byte("2004"), {0x1b}} {
		if bytes.Contains(out, marker) {
			t.Fatalf("%q 가 남아 있다: %q", marker, out)
		}
	}
}

// 감쌀 때 **모드 신호**를 넣으면 안 된다. 방향이 반대인 시퀀스이고, 넣으면
// `zsh: command not found: 2004hecho` 가 된다 — 실제로 그렇게 틀렸었다.
func TestWrapPaste_UsesPasteMarkersNotModeSignals(t *testing.T) {
	out := wrapPaste([]byte("x"), true)
	if bytes.Contains(out, []byte("2004")) {
		t.Fatalf("감싸기에 모드 신호가 섞였다: %q", out)
	}
	if !bytes.HasPrefix(out, []byte("\x1b[200~")) || !bytes.HasSuffix(out, []byte("\x1b[201~")) {
		t.Fatalf("마커가 틀렸다: %q", out)
	}
}
