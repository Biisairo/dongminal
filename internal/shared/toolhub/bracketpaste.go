package toolhub

import (
	"bytes"
	"fmt"
	"time"
)

// bracketed paste 모드 추적 (BRACKETED_PASTE_SRS 묶음 A).
//
// 앱(셸)이 터미널에게 "붙여넣기를 감싸서 보내라" 고 알리는 신호가 DECSET 2004 다.
// 켜기 ESC[?2004h, 끄기 ESC[?2004l. **켠 적 없는 셸에 감싸서 보내면 마커가 글자
// 그대로 명령줄에 들어간다** — macOS 가 싣는 bash 3.2 가 정확히 그렇다.
//
// 그래서 감싸도 되는지는 기억이 아니라 **관찰**로 정한다.

// 두 쌍을 혼동하면 안 된다 — 방향도 뜻도 다르다.
//
//	bpOn·bpOff     앱 → 터미널. "감싸서 보내라 / 그만 보내라" (DECSET 2004)
//	pasteBegin·End 터미널 → 앱. 붙여넣은 텍스트를 감싸는 마커
//
// 감쌀 때 모드 신호를 대신 넣으면 그것이 명령줄에 글자로 들어간다.
var (
	bpOn  = []byte("\x1b[?2004h")
	bpOff = []byte("\x1b[?2004l")

	pasteBegin = []byte("\x1b[200~")
	pasteEnd   = []byte("\x1b[201~")
)

// bpMaxCarry 는 읽기 경계에 걸친 시퀀스의 이월 상한이다. 시퀀스 자체가 8바이트라
// 그 직전까지만 들고 있으면 된다. 상한이 없으면 ESC 로 시작해 끝나지 않는 출력이
// 메모리를 먹는다 (FR-BPT-3).
const bpMaxCarry = 8

// scanBracketedPaste 는 청크에서 마지막 DECSET 2004 신호를 찾는다.
//
// 한 청크에 켜기와 끄기가 함께 오면 **마지막 것이 이긴다** — 순서가 곧 상태다
// (FR-BPT-2). 신호가 없으면 state 는 nil 이고 호출자는 종전 상태를 유지한다.
//
// carry 는 다음 청크에 이어 붙일 꼬리다. 시퀀스가 경계에 걸쳐 쪼개져도 놓치지
// 않기 위한 것이다 (FR-BPT-3).
func scanBracketedPaste(scan []byte) (state *bool, carry []byte) {
	on := bytes.LastIndex(scan, bpOn)
	off := bytes.LastIndex(scan, bpOff)
	if on >= 0 || off >= 0 {
		v := on > off
		state = &v
	}
	return state, bpCarry(scan)
}

// bpCarry 는 청크 끝의 미완성 시퀀스를 낸다. 마지막 ESC 이후가 시퀀스의 접두사일
// 수 있을 때만 들고 간다.
func bpCarry(scan []byte) []byte {
	i := bytes.LastIndexByte(scan, 0x1b)
	if i < 0 {
		return nil
	}
	tail := scan[i:]
	if len(tail) >= bpMaxCarry {
		// 완성될 자리는 지났다 — 이미 위에서 판정했거나 다른 시퀀스다.
		return nil
	}
	// 접두사로서 가능성이 남아 있을 때만 이월한다.
	if !bytes.HasPrefix(bpOn, tail) && !bytes.HasPrefix(bpOff, tail) {
		return nil
	}
	return append([]byte(nil), tail...)
}

// observeBracketedPaste 는 readPTY 고루틴이 청크마다 부른다.
//
// 판정은 이 고루틴만 하고(bpCarryBuf 는 잠금이 필요 없다), 결과는 원자값으로
// 입력 경로와 공유한다 (FR-BPT-4).
func (p *Tool) observeBracketedPaste(chunk []byte) {
	scan := chunk
	if len(p.bpCarryBuf) > 0 {
		scan = append(append([]byte(nil), p.bpCarryBuf...), chunk...)
	}
	// ESC 가 없으면 신호도 없다 — 뜨거운 경로를 한 번의 스캔으로 빠져나간다
	// (NFR-BP-1).
	if bytes.IndexByte(scan, 0x1b) < 0 {
		p.bpCarryBuf = nil
		return
	}
	state, carry := scanBracketedPaste(scan)
	p.bpCarryBuf = carry
	if state != nil {
		p.bracketedPaste.Store(*state)
	}
}

// BracketedPaste 는 이 도구의 셸이 붙여넣기 감싸기를 **켜 두었는지** 다.
//
// 켠 적이 없으면 false 이고, 그 셸에 감싸서 보내면 안 된다. vim 을 열면 켜지고
// 나오면 꺼지는 것이 정상이다 — 기억하지 않고 그때그때 따라간다 (FR-BPT-5).
func (p *Tool) BracketedPaste() bool { return p.bracketedPaste.Load() }

// pasteSubmitDelay 는 감싼 텍스트와 제출(\r) 사이의 틈이다. 값이 한 곳에만
// 있어야 direct 모드와 daemon 모드가 갈라지지 않는다 (FR-BPW-3).
const pasteSubmitDelay = 120 * time.Millisecond

// SendPaste 는 도구에 텍스트를 넣고, submit 이면 제출까지 한다.
//
// **감싸기 판단이 여기 있는 것이 요점이다** (FR-BPW-1). 셸이 그 모드를 켰는지는
// PTY 출력을 읽는 쪽만 알고, daemon 모드의 클라이언트는 그 사실에 닿을 수 없다 —
// Hub.Get 이 cmd 없는 합성 Tool 을 주기 때문이다. Cwd·Busy 가 같은 이유로 데몬
// RPC 를 경유하는 것과 같은 자리다.
func (m *ToolManager) SendPaste(id string, text []byte, submit bool) error {
	m.mu.RLock()
	p := m.tools[id]
	m.mu.RUnlock()
	if p == nil {
		return fmt.Errorf("tool 없음: %s", id)
	}
	if err := p.Write(wrapPaste(text, p.BracketedPaste())); err != nil {
		return fmt.Errorf("터미널 쓰기 (paste): %w", err)
	}
	if !submit {
		return nil
	}
	time.Sleep(pasteSubmitDelay)
	if err := p.Write([]byte{'\r'}); err != nil {
		return fmt.Errorf("터미널 쓰기 (submit): %w", err)
	}
	return nil
}

// wrapPaste 는 모드가 켜져 있을 때만 감싼다. 꺼져 있으면 **원문 그대로** 다
// (FR-BPW-2) — 켠 적 없는 셸에 마커를 보내면 그것이 명령줄에 글자로 들어간다.
func wrapPaste(text []byte, bracketed bool) []byte {
	if !bracketed {
		return text
	}
	out := make([]byte, 0, len(pasteBegin)+len(text)+len(pasteEnd))
	out = append(out, pasteBegin...)
	out = append(out, text...)
	out = append(out, pasteEnd...)
	return out
}
