package server

import "regexp"

// osc777Pattern matches dongminal's private OSC 777 sequences:
//
//	ESC ] 777 ; <cmd> ; <payload> BEL
//
// FR-A1: snapshot replay must not re-execute these on the client.
var osc777Pattern = regexp.MustCompile(`\x1b\]777;[^\x07]*\x07`)

// stripOSC777 removes every complete OSC 777 sequence from b without
// altering other bytes (including regular CSI ANSI escapes). Incomplete
// sequences (no terminating BEL) are left intact.
func stripOSC777(b []byte) []byte {
	return osc777Pattern.ReplaceAll(b, nil)
}

// snapshotQueryPattern matches terminal *query* control sequences that make a
// client terminal (xterm.js) emit an automatic reply (CPR "…R", DA "…c", …).
// Such queries in replayed scrollback are stale — the program that asked is
// long gone — so the reply is injected into the shell as junk input, kicking
// off a feedback loop (e.g. an endless "56;9R56;9R…" flood on reconnect).
var snapshotQueryPattern = regexp.MustCompile(
	`\x1b\[` + // CSI
		`(?:` +
		`0c|` + // DA (Device Attributes)
		`6n|` + // DSR (Device Status Report — cursor position)
		`5n|` + // DSR (Device Status Report — device status)
		`[0-9]*;[0-9]*R` + // CPR (Cursor Position Report — injected reply)
		`)`,
)

// stripSnapshotQueries removes terminal query sequences from b so that
// replaying a scrollback snapshot never makes the client terminal send an
// automatic reply back into the PTY. Only queries are removed; ordinary output
// (colors, cursor moves, already-present responses) is left intact.
func stripSnapshotQueries(b []byte) []byte {
	return snapshotQueryPattern.ReplaceAll(b, nil)
}
