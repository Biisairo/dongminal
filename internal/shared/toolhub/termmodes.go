package toolhub

import (
	"bytes"
	"strconv"
)

// 터미널 모드의 추적과 복원 (TERMINAL_MODE_RESTORE_SRS 묶음 M·R).
//
// **왜 서버가 이것을 드는가.** 앱이 켠 모드는 `ESC[?…h` 를 **본** 터미널만 안다.
// 브라우저가 다시 붙으면 새 xterm 이 서고, 그 인스턴스는 아무것도 모른 채 시작한다.
// 화면은 스크롤백 재생으로 되살아나지만 모드는 그렇지 않다 — 재생의 재료인
// 링버퍼(`bufMax`, 1MB)를 출력이 넘어서면 앱이 시작할 때 보낸 그 한 줄이 밀려나
// 있기 때문이다.
//
// 그 유실이 조용히 만든 결함이 접수된 `U-32` 다: 이미지를 `Cmd+V` 하면 클립보드의
// `text/plain` 이 비어 있고, xterm 은 bracketed paste 가 켜져 있을 때만 그 빈
// 문자열을 `ESC[200~ESC[201~` 로 감싼다. 감싸지 않으면 빈 문자열이고, 프론트의
// `_sendText` 가 그것을 버린다 — Claude Code 는 `Cmd+V` 가 눌린 사실조차 모른다.

// 관심 있는 DEC private mode 들 (FR-TMR-2). 여기 없는 번호는 무시한다 —
// `ESC[?25h`(커서 보이기)처럼 흔한 것들이 상태를 흔들면 안 된다 (FR-TMR-5).
const (
	modeBracketedPaste = 2004
	modeFocusEvent     = 1004
)

// mouseProtocols·mouseEncodings 는 **갈래**다. 각 갈래에서 살아남는 값은 하나이며
// (FR-TMR-3), 갈래에 속한 어느 번호의 끄기든 그 갈래를 비운다 (FR-TMR-4).
//
// xterm 의 모델이 그렇다 — `activeProtocol` 하나, 인코딩 하나다. 비트 집합으로
// 기억하면 `1002h` 뒤 `1003h` 의 순서를 잃어 복원이 화면과 어긋난다.
var (
	mouseProtocols = []int{9, 1000, 1002, 1003}
	mouseEncodings = []int{1005, 1006, 1015}
)

// TermModes 는 앱이 켜 둔 모드다. 제로값은 **전부 꺼짐**이며, 그것이 새 xterm 의
// 기본값과 같다.
type TermModes struct {
	BracketedPaste bool `json:"bracketedPaste"`
	// MouseProtocol 은 `9`·`1000`·`1002`·`1003` 중 하나다. 0 이면 없음.
	MouseProtocol int `json:"mouseProtocol"`
	// MouseEncoding 은 `1005`·`1006`·`1015` 중 하나다. 0 이면 기본.
	MouseEncoding int  `json:"mouseEncoding"`
	FocusEvent    bool `json:"focusEvent"`
}

// RestoreBytes 는 켜진 모드를 다시 세우는 바이트다 (FR-TMR-20).
//
// **켜진 것만 담는다** (FR-TMR-22) — 새 xterm 의 기본이 전부 꺼짐이므로 끄기를
// 명시하는 것은 없는 문제에 바이트를 쓰는 일이다. 순서는 프로토콜 → 인코딩 →
// 나머지로, 앱이 보내는 관례와 같게 둔다 (FR-TMR-23).
func (m TermModes) RestoreBytes() []byte {
	var out []byte
	set := func(n int) {
		out = append(out, "\x1b[?"...)
		out = strconv.AppendInt(out, int64(n), 10)
		out = append(out, 'h')
	}
	if m.MouseProtocol != 0 {
		set(m.MouseProtocol)
	}
	if m.MouseEncoding != 0 {
		set(m.MouseEncoding)
	}
	if m.BracketedPaste {
		set(modeBracketedPaste)
	}
	if m.FocusEvent {
		set(modeFocusEvent)
	}
	return out
}

// 원자값으로 실어 나르기 위한 포장 (FR-TMR-7). 필드가 넷이므로 구조체를 그대로
// 원자적으로 쓸 수 없고, `atomic.Value` 의 박싱은 청크마다의 할당이 된다.
// 제로값이 "전부 꺼짐" 인 것이 그대로 유지되는 것이 이 포장의 값이다.
func (m TermModes) pack() uint64 {
	v := uint64(uint16(m.MouseProtocol)) | uint64(uint16(m.MouseEncoding))<<16
	if m.BracketedPaste {
		v |= 1 << 32
	}
	if m.FocusEvent {
		v |= 1 << 33
	}
	return v
}

func unpackModes(v uint64) TermModes {
	return TermModes{
		BracketedPaste: v&(1<<32) != 0,
		MouseProtocol:  int(uint16(v)),
		MouseEncoding:  int(uint16(v >> 16)),
		FocusEvent:     v&(1<<33) != 0,
	}
}

// TermModes 는 이 도구의 앱이 **지금 켜 두고 있는** 모드다.
func (p *Tool) TermModes() TermModes { return unpackModes(p.modes.Load()) }

// BracketedPaste 는 그 중 하나를 묻는 얇은 접근자다 (FR-TMR-8).
//
// 계약은 종전 그대로다 — 켠 적이 없으면 false 이고, 그 셸에 감싸서 보내면 안
// 된다. vim 을 열면 켜지고 나오면 꺼지는 것이 정상이다 (FR-BPT-5).
func (p *Tool) BracketedPaste() bool { return p.modes.Load()&(1<<32) != 0 }

// modeMaxCarry 는 읽기 경계에 걸친 시퀀스의 이월 상한이다 (FR-TMR-6).
//
// 종전의 8바이트는 `ESC[?2004h` 만 재던 값이다. 파라미터를 묶은 형태
// (`ESC[?1000;1002;1003;1006h`, 24바이트)를 담지 못하므로 넓힌다. 상한이 **있다**는
// 것이 값보다 중요하다 — 없으면 ESC 로 시작해 끝나지 않는 출력이 메모리를 먹는다.
const modeMaxCarry = 64

// observeModes 는 readPTY 고루틴이 청크마다 부른다 (FR-TMR-7).
//
// 판정은 이 고루틴만 하고(modeCarryBuf 는 잠금이 필요 없다), 결과는 원자값으로
// 입력·재접속 경로와 공유한다.
func (p *Tool) observeModes(chunk []byte) {
	scan := chunk
	if len(p.modeCarryBuf) > 0 {
		scan = append(append([]byte(nil), p.modeCarryBuf...), chunk...)
	}
	// ESC 가 없으면 설정도 없다 — 뜨거운 경로를 한 번의 스캔으로 빠져나간다
	// (NFR-BP-1 유지).
	if bytes.IndexByte(scan, 0x1b) < 0 {
		p.modeCarryBuf = nil
		return
	}
	cur := unpackModes(p.modes.Load())
	next, carry := scanModes(scan, cur)
	p.modeCarryBuf = carry
	if next != cur {
		p.modes.Store(next.pack())
	}
}

// scanModes 는 청크의 DEC private mode 설정을 **나오는 순서대로** 적용한다
// (FR-TMR-1·3) — 순서가 곧 상태다.
//
// carry 는 다음 청크에 이어 붙일 꼬리다. 시퀀스가 경계에 쪼개져도 놓치지 않기
// 위한 것이다 (FR-TMR-6).
func scanModes(scan []byte, cur TermModes) (TermModes, []byte) {
	for i := 0; i < len(scan); {
		j := bytes.IndexByte(scan[i:], 0x1b)
		if j < 0 {
			return cur, nil
		}
		start := i + j
		params, final, end, ok := parsePrivateMode(scan[start:])
		if !ok {
			// 완성될 가능성이 남아 있으면 이월한다. 아니면 이 ESC 를 지나친다.
			if end < 0 && len(scan)-start < modeMaxCarry {
				return cur, append([]byte(nil), scan[start:]...)
			}
			i = start + 1
			continue
		}
		for _, n := range params {
			cur = applyMode(cur, n, final == 'h')
		}
		i = start + end
	}
	return cur, nil
}

// parsePrivateMode 는 `ESC[?<n>[;<n>…]<h|l>` 하나를 읽는다.
//
// ok 가 거짓이고 end 가 음수면 **아직 끝나지 않은 것**이다 — 이월 대상이다.
// 거짓이고 end 가 0 이상이면 우리가 찾는 모양이 아니다 (다른 이스케이프).
func parsePrivateMode(b []byte) (params []int, final byte, end int, ok bool) {
	if len(b) < 3 {
		if bytes.HasPrefix([]byte("\x1b[?"), b) {
			return nil, 0, -1, false
		}
		return nil, 0, 0, false
	}
	if b[1] != '[' || b[2] != '?' {
		return nil, 0, 0, false
	}
	n := 0
	seen := false
	for i := 3; i < len(b); i++ {
		c := b[i]
		switch {
		case c >= '0' && c <= '9':
			n = n*10 + int(c-'0')
			seen = true
			// 터무니없이 긴 수는 우리 것이 아니다.
			if n > 1<<20 {
				return nil, 0, i, false
			}
		case c == ';':
			params = append(params, n)
			n, seen = 0, false
		case c == 'h' || c == 'l':
			if seen || len(params) > 0 {
				params = append(params, n)
			}
			return params, c, i + 1, len(params) > 0
		default:
			// `ESC[?…$p`(모드 질의) 등 — 우리 모양이 아니다.
			return nil, 0, i, false
		}
	}
	// 끝까지 종결자가 없었다: 다음 청크에 이어질 수 있다.
	return nil, 0, -1, false
}

// applyMode 는 설정 하나를 적용한다. 관심 밖이면 그대로 돌려준다 (FR-TMR-5).
func applyMode(m TermModes, n int, on bool) TermModes {
	switch {
	case n == modeBracketedPaste:
		m.BracketedPaste = on
	case n == modeFocusEvent:
		m.FocusEvent = on
	case contains(mouseProtocols, n):
		// FR-TMR-4: 끄기는 **갈래를 비운다.** 어느 번호로 껐는지는 묻지 않는다 —
		// xterm 이 그렇게 하고, 다르게 기억하면 복원이 화면과 어긋난다.
		if on {
			m.MouseProtocol = n
		} else {
			m.MouseProtocol = 0
		}
	case contains(mouseEncodings, n):
		if on {
			m.MouseEncoding = n
		} else {
			m.MouseEncoding = 0
		}
	}
	return m
}

func contains(xs []int, n int) bool {
	for _, x := range xs {
		if x == n {
			return true
		}
	}
	return false
}
