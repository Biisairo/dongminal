package toolhub

import (
	"bytes"
	"os"
	"strconv"
	"time"
)

// Tool attention (PANE_ATTENTION_NOTIFY_SRS): terminal-monitoring based
// detection that a tool needs the user's attention — an agent finished or is
// waiting for input. Detection is observe-only over the PTY output stream:
//   L1 (signaled): standard notification escape sequences (OSC 9 / OSC 99 /
//                  OSC 777;notify, and optionally a bare BEL).
//   L2 (idle):     output quiescence after activity (handled by the sweeper).

const (
	// AttnMaxCarry bounds the per-tool carry holding an unterminated OSC
	// fragment that spans a read boundary. Beyond this the fragment is dropped.
	AttnMaxCarry = 512
	// attnDefaultIdleMS is the default L2 idle threshold. 0 would disable L2.
	attnDefaultIdleMS = 10000
	// attnTickMS is the idle sweeper tick period.
	attnTickMS = 1000
)

// attnNow returns the current time in unix-nanos. It is a package variable so
// tests can substitute a deterministic clock (mirrors toolBusyProbe).
var attnNow = func() int64 { return time.Now().UnixNano() }

// AttentionIdleThreshold resolves the L2 idle threshold: env override
// (DONGMINAL_ATTENTION_IDLE_MS) or the named default. 0 disables L2.
func AttentionIdleThreshold() time.Duration {
	ms := attnDefaultIdleMS
	if v := os.Getenv("DONGMINAL_ATTENTION_IDLE_MS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			ms = n
		}
	}
	return time.Duration(ms) * time.Millisecond
}

// attentionAllowBell resolves whether a bare BEL counts as an attention signal.
// Off by default (BEL is noisy: tab-completion, etc.).
func attentionAllowBell() bool {
	return os.Getenv("DONGMINAL_ATTENTION_BELL") == "1"
}

// DetectAttentionSignal scans b (already prepended with any prior carry) for
// terminal notification escape sequences and, when allowBell is set, a bare
// BEL. It is observe-only and never mutates the live stream. It returns
// whether a signal was found and a bounded carry — an unterminated trailing
// OSC fragment to prepend to the next chunk (nil when none / dropped).
//
// Carry mechanism: a fragmented OSC sequence (ESC ] … without a BEL or ST
// terminator) is saved as the carry and prepended to the next chunk. This
// handles cross-chunk OSC sequences (e.g. when the PTY read buffer splits a
// long OSC 9;… sequence across two reads). The carry is bounded by maxCarry:
// fragments exceeding the limit are silently dropped. This is intentional —
// an unterminated OSC that large is either a runaway sequence or a malformed
// escape, and keeping it unbounded would risk memory growth. The next chunk
// starts fresh without the carry, so a single legitimate notification
// spanning two reads will still be detected as long as the OSC body is
// shorter than maxCarry.
func DetectAttentionSignal(b []byte, allowBell bool, maxCarry int) (bool, []byte) {
	i, n := 0, len(b)
	for i < n {
		c := b[i]
		switch {
		case c == 0x07: // BEL outside any OSC body (OSC bodies are consumed below)
			if allowBell {
				return true, nil
			}
			i++
		case c == 0x1b: // ESC
			if i+1 >= n {
				return false, boundedCarry(b[i:], maxCarry) // lone trailing ESC
			}
			if b[i+1] == ']' { // OSC introducer: ESC ]
				end, termLen := findOSCTerminator(b, i+2)
				if end < 0 {
					return false, boundedCarry(b[i:], maxCarry) // unterminated OSC
				}
				if isAttentionOSC(b[i+2 : end]) {
					return true, nil
				}
				i = end + termLen
			} else {
				i += 2 // other ESC sequence (CSI, etc.) — bytes that follow are ordinary
			}
		default:
			i++
		}
	}
	return false, nil
}

// findOSCTerminator returns the index and length of the OSC string terminator
// (BEL=1 byte, or ST "ESC \"=2 bytes) at or after from, or (-1, 0) if the OSC
// is not yet terminated within b.
func findOSCTerminator(b []byte, from int) (int, int) {
	for k := from; k < len(b); k++ {
		switch b[k] {
		case 0x07:
			return k, 1
		case 0x1b:
			if k+1 < len(b) && b[k+1] == '\\' {
				return k, 2
			}
			return -1, 0 // ESC at end, or ESC not forming ST → treat as unterminated
		}
	}
	return -1, 0
}

// isAttentionOSC reports whether an OSC body (the bytes between "ESC ]" and the
// terminator) is a notification request: OSC 9 (excluding the 9;4 progress
// form), OSC 99 (kitty), or OSC 777;notify.
func isAttentionOSC(body []byte) bool {
	id := body
	var rest []byte
	if semi := bytes.IndexByte(body, ';'); semi >= 0 {
		id = body[:semi]
		rest = body[semi+1:]
	}
	switch string(id) {
	case "99":
		return true
	case "9":
		// OSC 9;4;... is ConEmu/Windows-Terminal progress, not a notification.
		if bytes.Equal(rest, []byte("4")) || bytes.HasPrefix(rest, []byte("4;")) {
			return false
		}
		return true
	case "777":
		sub := rest
		if j := bytes.IndexByte(rest, ';'); j >= 0 {
			sub = rest[:j]
		}
		return string(sub) == "notify"
	}
	return false
}

// boundedCarry copies frag for use as the next carry, or returns nil when it
// exceeds maxCarry (drop to keep memory bounded).
func boundedCarry(frag []byte, maxCarry int) []byte {
	if len(frag) > maxCarry {
		return nil
	}
	return append([]byte(nil), frag...)
}

// toolAttentionPayload / toolAttentionClearPayload build the SSE event bodies
