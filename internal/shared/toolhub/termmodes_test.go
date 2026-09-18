package toolhub

import (
	"bytes"
	"testing"
)

// TERMINAL_MODE_RESTORE_SRS 묶음 M·R — 앱이 켜 둔 모드를 추적하고 재접속에서
// 되세운다 (V-TMR-1~8).
//
// 재는 것은 **xterm 의 모델과 같은가** 다 (§2.4). xterm 은 마우스를 플래그
// 여럿이 아니라 `activeProtocol` 하나로 들고, 인코딩도 하나다 — 우리가 비트
// 집합으로 기억하면 순서를 잃어 복원이 화면과 어긋난다.

func modesAfter(t *testing.T, chunks ...string) TermModes {
	t.Helper()
	var p Tool
	for _, c := range chunks {
		p.observeModes([]byte(c))
	}
	return p.TermModes()
}

// V-TMR-1 (FR-TMR-1): 파라미터를 묶어 보내는 형태를 본다. 마우스 모드는 이
// 형태가 흔하고, 종전의 리터럴 대조로는 **구조적으로 볼 수 없었다**.
func TestModes_BundledParams(t *testing.T) {
	m := modesAfter(t, "\x1b[?1002;1006h")
	if m.MouseProtocol != 1002 {
		t.Errorf("protocol=%d want 1002", m.MouseProtocol)
	}
	if m.MouseEncoding != 1006 {
		t.Errorf("encoding=%d want 1006", m.MouseEncoding)
	}
}

// V-TMR-2 (FR-TMR-3): 같은 갈래는 **마지막이 이긴다.** 프로토콜은 하나뿐이다.
func TestModes_LastProtocolWins(t *testing.T) {
	if got := modesAfter(t, "\x1b[?1002h", "\x1b[?1003h").MouseProtocol; got != 1003 {
		t.Fatalf("protocol=%d want 1003", got)
	}
	if got := modesAfter(t, "\x1b[?1006h", "\x1b[?1015h").MouseEncoding; got != 1015 {
		t.Fatalf("encoding=%d want 1015", got)
	}
}

// V-TMR-3 (FR-TMR-4): 갈래에 속한 **어느 번호의 끄기**든 그 갈래를 비운다.
//
// xterm 이 그렇게 한다 — 우리가 "1002 로 켰으니 1002l 만 듣는다" 로 기억하면
// 화면은 꺼졌는데 우리는 켜진 줄 알고 복원해 클릭이 앱으로 새어 간다.
func TestModes_AnyResetClearsGroup(t *testing.T) {
	if got := modesAfter(t, "\x1b[?1002h", "\x1b[?1000l").MouseProtocol; got != 0 {
		t.Errorf("protocol=%d want 0", got)
	}
	if got := modesAfter(t, "\x1b[?1006h", "\x1b[?1005l").MouseEncoding; got != 0 {
		t.Errorf("encoding=%d want 0", got)
	}
	if got := modesAfter(t, "\x1b[?2004h", "\x1b[?2004l").BracketedPaste; got {
		t.Errorf("bracketedPaste=true want false")
	}
}

// V-TMR-4 (FR-TMR-5): 관심 밖의 모드는 아무것도 흔들지 않는다.
func TestModes_IgnoresOthers(t *testing.T) {
	m := modesAfter(t, "\x1b[?2004h", "\x1b[?25h", "\x1b[?1049h", "\x1b[?7l")
	if !m.BracketedPaste {
		t.Error("무관한 모드가 bracketed paste 를 껐다")
	}
	if m.MouseProtocol != 0 || m.MouseEncoding != 0 || m.FocusEvent {
		t.Errorf("무관한 모드가 상태를 만들었다: %+v", m)
	}
}

// V-TMR-5 (FR-TMR-6): 묶인 시퀀스가 청크 경계에 쪼개져도 잡는다.
//
// 종전의 이월 상한 8바이트는 `ESC[?1000;1002;1003;1006h` 를 담지 못한다. 이것이
// 무너지면 모드가 켜졌는데 꺼진 것으로 오판한다 — 조용히 잘못되는 쪽이다.
func TestModes_SplitAcrossReads(t *testing.T) {
	full := "\x1b[?1000;1002;1003;1006h"
	for cut := 1; cut < len(full); cut++ {
		var p Tool
		p.observeModes([]byte(full[:cut]))
		p.observeModes([]byte(full[cut:]))
		m := p.TermModes()
		if m.MouseProtocol != 1003 || m.MouseEncoding != 1006 {
			t.Fatalf("cut=%d: %+v — 경계에서 놓쳤다", cut, m)
		}
	}
}

// V-TMR-7 (FR-TMR-23): 복원 시퀀스는 **켜진 것만** 담고 순서는
// 프로토콜 → 인코딩 → 나머지다.
func TestModes_RestoreBytes(t *testing.T) {
	m := TermModes{BracketedPaste: true, MouseProtocol: 1002, MouseEncoding: 1006, FocusEvent: true}
	got := m.RestoreBytes()
	want := []byte("\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h")
	if !bytes.Equal(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
}

// V-TMR-8 (FR-TMR-22): 아무것도 켜지지 않았으면 **빈 바이트**다. 새 xterm 의
// 기본값이 전부 꺼짐이므로 끄기를 명시할 이유가 없다.
func TestModes_RestoreEmptyWhenNothingOn(t *testing.T) {
	if got := (TermModes{}).RestoreBytes(); len(got) != 0 {
		t.Fatalf("got %q want empty", got)
	}
}

// 되세운 바이트를 다시 관찰하면 같은 상태가 나와야 한다 — 복원이 관찰의
// 역함수여야 두 모드(direct·daemon)가 같은 화면에 이른다.
func TestModes_RestoreRoundTrips(t *testing.T) {
	want := TermModes{BracketedPaste: true, MouseProtocol: 1003, MouseEncoding: 1015, FocusEvent: true}
	var p Tool
	p.observeModes(want.RestoreBytes())
	if got := p.TermModes(); got != want {
		t.Fatalf("got %+v want %+v", got, want)
	}
}

// V-TRS-17c (TERMINAL_RESUME_SRS FR-TRS-18b): alt screen 은 **관측하되 복원하지
// 않는다.**
//
// 넛지를 걸지 말지를 가르는 데 필요한 것은 *켜져 있는가* 하나뿐이다. 되세우는
// 일은 여전히 비목표다 — 버퍼 전환은 내용을 동반하므로 규칙이 다르다.
func TestModes_AltScreenObservedNotRestored(t *testing.T) {
	for _, n := range []string{"\x1b[?1049h", "\x1b[?47h", "\x1b[?1047h"} {
		if !modesAfter(t, n).AltScreen {
			t.Errorf("%q 를 보고도 alt screen 이 아니라고 한다", n)
		}
	}
	if modesAfter(t, "\x1b[?1049h", "\x1b[?1049l").AltScreen {
		t.Error("나간 뒤에도 alt screen 이라고 한다")
	}
	// 켜진 채여도 복원 바이트에는 담기지 않는다.
	m := TermModes{AltScreen: true, BracketedPaste: true}
	if got := string(m.RestoreBytes()); got != "\x1b[?2004h" {
		t.Fatalf("복원 바이트=%q — alt screen 이 섞였다", got)
	}
}
