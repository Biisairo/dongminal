package toolhub

import (
	"bytes"
	"fmt"
	"time"
)

// 붙여넣기의 감싸기와 전송 (BRACKETED_PASTE_SRS 묶음 W).
//
// **모드 추적은 `termmodes.go` 로 옮겼다** (TERMINAL_MODE_RESTORE_SRS FR-TMR-1).
// 앱이 켜는 것은 bracketed paste 만이 아니고, 재접속이 그 전부를 잃기 때문이다.
// 여기 남은 것은 "켜져 있으면 감싼다" 는 판단과 그 전송이다.

// 두 쌍을 혼동하면 안 된다 — 방향도 뜻도 다르다.
//
//	ESC[?2004h/l   앱 → 터미널. "감싸서 보내라 / 그만 보내라" (DECSET 2004)
//	pasteBegin·End 터미널 → 앱. 붙여넣은 텍스트를 감싸는 마커
//
// 감쌀 때 모드 신호를 대신 넣으면 그것이 명령줄에 글자로 들어간다.
var (
	pasteBegin = []byte("\x1b[200~")
	pasteEnd   = []byte("\x1b[201~")
)

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
	// 틈은 도구의 죽음으로 끊긴다 — 죽은 도구 앞에서 자지 않는다 (M8 `GO-12`).
	// 데몬 모드에서 이 함수는 연결 하나를 직렬 처리하는 핸들러 안에서 돌므로,
	// 여기서 자는 시간은 곧 그 연결의 다른 RPC 가 기다리는 시간이다.
	gap := time.NewTimer(pasteSubmitDelay)
	defer gap.Stop()
	select {
	case <-gap.C:
	case <-p.Wait():
		return fmt.Errorf("터미널 쓰기 (submit): 도구가 끝났다")
	}
	if err := p.Write([]byte{'\r'}); err != nil {
		return fmt.Errorf("터미널 쓰기 (submit): %w", err)
	}
	return nil
}

// wrapPaste 는 모드가 켜져 있을 때만 감싼다. 꺼져 있으면 **원문 그대로** 다
// (FR-BPW-2) — 켠 적 없는 셸에 마커를 보내면 그것이 명령줄에 글자로 들어간다.
//
// 감쌀 때는 본문 안의 **종료 마커를 제거한다** (M8_UNIFIED_SRS D-A-8, 10-func-backend
// FBE-18). `read-output | dmctl msg -` 는 ANSI 를 그대로 나르므로 본문에 `ESC[201~`
// 이 올 수 있고, 그러면 수신 셸이 구간을 조기 종료해 나머지를 타이핑으로 읽는다.
func wrapPaste(text []byte, bracketed bool) []byte {
	if !bracketed {
		return text
	}
	body := bytes.ReplaceAll(text, pasteEnd, nil)
	out := make([]byte, 0, len(pasteBegin)+len(body)+len(pasteEnd))
	out = append(out, pasteBegin...)
	out = append(out, body...)
	out = append(out, pasteEnd...)
	return out
}
