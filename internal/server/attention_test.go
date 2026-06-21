package server

import (
	"bytes"
	"strings"
	"testing"
)

// TC-PAN-1..7: pure detector for terminal notification escape sequences.

func TestDetectAttentionSignal_OSC9_Bel(t *testing.T) {
	sig, carry := detectAttentionSignal([]byte("\x1b]9;build done\a"), false, attnMaxCarry)
	if !sig {
		t.Fatalf("OSC 9 (BEL) should signal")
	}
	if carry != nil {
		t.Fatalf("complete sequence should leave no carry, got %q", carry)
	}
}

func TestDetectAttentionSignal_OSC9_ST(t *testing.T) {
	sig, _ := detectAttentionSignal([]byte("\x1b]9;hi\x1b\\"), false, attnMaxCarry)
	if !sig {
		t.Fatalf("OSC 9 terminated by ST should signal")
	}
}

func TestDetectAttentionSignal_OSC777Notify(t *testing.T) {
	sig, _ := detectAttentionSignal([]byte("\x1b]777;notify;Title;Body\a"), false, attnMaxCarry)
	if !sig {
		t.Fatalf("OSC 777;notify should signal")
	}
}

func TestDetectAttentionSignal_OSC99(t *testing.T) {
	sig, _ := detectAttentionSignal([]byte("\x1b]99;;message\x1b\\"), false, attnMaxCarry)
	if !sig {
		t.Fatalf("OSC 99 (kitty) should signal")
	}
}

func TestDetectAttentionSignal_PlainAndAnsi(t *testing.T) {
	cases := [][]byte{
		[]byte("hello world\n"),
		[]byte("\x1b[31mred\x1b[0m text"), // CSI color, not OSC
		[]byte("\x1b]0;window title\a"),   // OSC 0 title — not attention
		[]byte("\x1b]777;cwd;/home/x\a"),  // private OSC 777 non-notify
		[]byte("\x1b]9;4;1;50\a"),         // OSC 9;4 progress — not a notification
	}
	for _, c := range cases {
		if sig, carry := detectAttentionSignal(c, false, attnMaxCarry); sig {
			t.Fatalf("non-notification input must not signal: %q", c)
		} else if carry != nil {
			t.Fatalf("complete non-notification input must leave no carry: %q -> %q", c, carry)
		}
	}
}

func TestDetectAttentionSignal_SplitAcrossChunks(t *testing.T) {
	sig1, carry := detectAttentionSignal([]byte("output\x1b]9;par"), false, attnMaxCarry)
	if sig1 {
		t.Fatalf("partial OSC must not signal yet")
	}
	if carry == nil {
		t.Fatalf("partial OSC must produce carry")
	}
	// next chunk: prepend carry as readPTY does.
	next := append(append([]byte(nil), carry...), []byte("tial done\a")...)
	sig2, carry2 := detectAttentionSignal(next, false, attnMaxCarry)
	if !sig2 {
		t.Fatalf("completed OSC across boundary should signal")
	}
	if carry2 != nil {
		t.Fatalf("completed sequence should clear carry, got %q", carry2)
	}
}

func TestDetectAttentionSignal_BareBell(t *testing.T) {
	// allowBell off: bare bell does not signal.
	if sig, _ := detectAttentionSignal([]byte("ding\a"), false, attnMaxCarry); sig {
		t.Fatalf("bare BEL must not signal when allowBell=false")
	}
	// allowBell on: bare bell signals.
	if sig, _ := detectAttentionSignal([]byte("ding\a"), true, attnMaxCarry); !sig {
		t.Fatalf("bare BEL must signal when allowBell=true")
	}
	// OSC-terminating BEL is NOT a bare bell even when allowBell=true (OSC 0 title).
	if sig, _ := detectAttentionSignal([]byte("\x1b]0;title\a"), true, attnMaxCarry); sig {
		t.Fatalf("OSC-terminating BEL must not be treated as bare bell")
	}
}

func TestDetectAttentionSignal_CarryOverflow(t *testing.T) {
	// Unterminated OSC longer than maxCarry must be dropped (carry nil), no growth.
	big := "\x1b]9;" + strings.Repeat("x", 1000)
	sig, carry := detectAttentionSignal([]byte(big), false, 512)
	if sig {
		t.Fatalf("unterminated OSC must not signal")
	}
	if carry != nil {
		t.Fatalf("oversized unterminated OSC must drop carry, got %d bytes", len(carry))
	}
}

func TestPaneAttentionPayload(t *testing.T) {
	p := paneAttentionPayload("7", "idle")
	if !bytes.Contains(p, []byte(`"action":"pane_attention"`)) ||
		!bytes.Contains(p, []byte(`"paneId":"7"`)) ||
		!bytes.Contains(p, []byte(`"reason":"idle"`)) {
		t.Fatalf("unexpected payload: %s", p)
	}
	c := paneAttentionClearPayload("7")
	if !bytes.Contains(c, []byte(`"action":"pane_attention_clear"`)) ||
		!bytes.Contains(c, []byte(`"paneId":"7"`)) {
		t.Fatalf("unexpected clear payload: %s", c)
	}
}
