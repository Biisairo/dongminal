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
//
// DA(final `c`)·DSR(final `n`)·CPR(final `R`) 은 **사(私)적 접두 `?` `>` `=` 를
// 달고도 온다.** 예전 패턴이 접두 없는 형태만 잡아 DECXCPR(`ESC[?6n`)이 스냅샷에
// 남았고, 새로고침·재접속마다 그 수만큼의 응답이 셸에 입력으로 꽂혔다 —
// 실측(2026-08-25) 결과 실행 중인 TUI 의 버퍼 400KB 에 1400여 건이 들어 있었다.
// 세 final 로 끝나는 CSI 는 질의·응답 외의 용도가 없으므로 접두·인자를 가리지
// 않고 지운다.
var snapshotQueryPattern = regexp.MustCompile(`\x1b\[[?>=]?[0-9;]*[cnR]`)

// stripSnapshotQueries removes terminal query sequences from b so that
// replaying a scrollback snapshot never makes the client terminal send an
// automatic reply back into the PTY. Only queries are removed; ordinary output
// (colors, cursor moves, already-present responses) is left intact.
func stripSnapshotQueries(b []byte) []byte {
	return snapshotQueryPattern.ReplaceAll(b, nil)
}
