package httpapi

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
//
// **그 셋만으로는 좁았다** (FR-TRS-5a). 실측(2026-09-20)으로 접수된 것은
// `11;rgb:3f3f/3f3f/3f3f2026;0$y2048;0$y2031;0$y1010;0$y1011;0$y` — 프롬프트에
// 찍힌 이 문자열은 **xterm 이 낸 응답 한 벌**이다. 앱이 기동할 때 보낸 OSC 색
// 질의와 DECRQM 질의가 스냅샷에 그대로 남아, 다시 붙은 새 xterm 이 그것들에
// 답한 것이다 (`3f3f/3f3f/3f3f` 는 zenburn 테마의 터미널 배경이다 — 답한 쪽이
// 우리 브라우저라는 증거다). 질의 셋을 xterm 이 **실제로 답하는** 세 갈래로
// 넓힌다:
//
//   - DECRQM (`ESC[?<n>$p`) — 응답 `ESC[?<n>;<v>$y`
//   - OSC 색 질의 (`ESC]4|5|10‥19;…;?` + BEL|ST) — 응답 `ESC]<n>;rgb:…`
//   - DECRQSS (`ESC P $q … ESC \`) — 응답 `ESC P 1$r … ESC \`
//
// 값을 싣고 오는 것은 질의가 아니다. OSC 갈래가 끝의 `;?` 를 요구하는 것이
// 그 경계다 — `ESC]11;rgb:…` 는 색을 **세우는** 명령이고, 지우면 재생된 화면의
// 색이 사라진다. 번호를 색 계열로 한정하는 것도 같은 이유다: 제목(`ESC]0;…`)에
// 든 물음표는 질의가 아니다.
var snapshotQueryPattern = regexp.MustCompile(
	`\x1b\[[?>=]?[0-9;]*[cnR]` +
		`|\x1b\[[?>=]?[0-9;]*\$p` +
		`|\x1b\](?:4|5|1[0-9])(?:;[^;\x07\x1b]*)*;\?(?:\x07|\x1b\\)` +
		`|\x1bP\$q[^\x1b]*\x1b\\`)

// stripSnapshotQueries removes terminal query sequences from b so that
// replaying a scrollback snapshot never makes the client terminal send an
// automatic reply back into the PTY. Only queries are removed; ordinary output
// (colors, cursor moves, already-present responses) is left intact.
func stripSnapshotQueries(b []byte) []byte {
	return snapshotQueryPattern.ReplaceAll(b, nil)
}
