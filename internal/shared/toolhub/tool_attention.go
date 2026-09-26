package toolhub

import (
	"bytes"
	"sync/atomic"

	"dongminal/internal/shared/activity"
)

// 도구 하나의 주의(L1 OSC·L2 유휴)·활동 상태기다 — tool.go 의 PTY 수명과 갈라
// 두었다 (M8 GO-15, D-A-10). 공통 상수·attnNow 는 attention.go, 턴 판정은 agentturn.go.

// observeOutput records output activity and runs observe-only L1 detection on
// the raw chunk. Called from the readPTY goroutine only; attnCarry needs no
// lock. The live bytes are never mutated.
func (p *Tool) observeOutput(chunk []byte) { p.observeOutputAt(chunk, attnNow()) }

// observeOutputAt is observeOutput with an injectable timestamp (tests).
func (p *Tool) observeOutputAt(chunk []byte, now int64) {
	p.observeOutputClassified(chunk, now, classifyEsc(chunk, p.allowBell))
}

// observeOutputClassified 는 청크 분류(classifyEsc)를 받는 observeOutputAt 이다 —
// readPTY 는 주의·모드 관측이 같은 분류 한 번을 나눠 쓴다 (FR-OPT-3-2).
func (p *Tool) observeOutputClassified(chunk []byte, now int64, c escClass) {
	p.LastOutputAt.Store(now)
	// FR-ATF-5: 재무장이 잠긴 동안에는 출력이 무장을 세우지 못한다. 시각은
	// 그래도 적는다 — 준비완료 사다리(FR-STA-4)가 그 값을 읽는다.
	if !p.attnRearmLocked.Load() {
		p.attnArmed.Store(true)
	}
	// 이월이 없고 OSC·BEL 의 기미도 없으면 탐지기가 할 일이 없다 (신호 없음·이월
	// 없음·cwd 없음이 확정이다). 이월은 언제나 ESC 로 시작하므로 이월이 있으면 돈다.
	if len(p.attnCarry) == 0 && !c.osc {
		return
	}
	scan := chunk
	if len(p.attnCarry) > 0 {
		scan = p.joinCarry(p.attnCarry, chunk)
	}
	// cwd 보고는 **알람 배선과 무관하게** 읽는다 (FR-WTC-2). 이 함수의 위쪽에서
	// `onAttention == nil` 로 돌아가지 않도록 순서를 지킨다 — 알람을 켜지 않은
	// 도구도 자기 자리는 말해야 한다.
	p.noteCwdReport(DetectCwdReport(scan))
	if p.onAttention == nil {
		return
	}
	sig, carry := DetectAttentionSignal(scan, p.allowBell, AttnMaxCarry)
	p.attnCarry = carry
	if sig {
		p.setAttention("signaled")
	}
}

// escClass 는 청크에 관측할 거리가 있는지다. 거짓이면 그 탐지기는 이월 없이 돌 때
// 아무것도 찾지 못하고 이월도 남기지 않는다 — 그래서 건너뛸 수 있다.
type escClass struct {
	osc   bool // ESC ] · 끝의 ESC · (allowBell 이면) BEL — 주의·cwd 탐지기
	modes bool // ESC [ ? · 끝의 ESC · 끝의 ESC [ — 모드 탐지기
}

// classifyEsc 는 청크의 ESC 를 한 번 훑어 두 탐지기가 돌아야 하는지 가른다
// (FR-OPT-3-2, SHR-4). TUI 출력의 대부분인 색·커서 CSI 만 있는 청크는 이 한 번으로
// 끝난다.
func classifyEsc(b []byte, allowBell bool) (c escClass) {
	if allowBell && bytes.IndexByte(b, 0x07) >= 0 {
		c.osc = true
	}
	for i := 0; i < len(b); i++ {
		j := bytes.IndexByte(b[i:], 0x1b)
		if j < 0 {
			return c
		}
		i += j
		switch {
		case i+1 >= len(b):
			c.osc, c.modes = true, true
		case b[i+1] == ']':
			c.osc = true
		case b[i+1] == '[' && (i+2 >= len(b) || b[i+2] == '?'):
			c.modes = true
		}
		if c.osc && c.modes {
			return c
		}
	}
	return c
}

// joinCarry 는 이월 뒤에 청크를 이어 붙인 것을 scanScratch 에 만든다. 결과는 다음
// 호출이 덮으므로 보관하지 않는다 — 이월은 탐지기가 따로 복사해 돌려준다.
func (p *Tool) joinCarry(carry, chunk []byte) []byte {
	p.scanScratch = append(append(p.scanScratch[:0], carry...), chunk...)
	return p.scanScratch
}

// setAttention transitions none→attention exactly once (edge), firing the
// notifier only on the transition (NFR-PAN-3). Returns true if it transitioned.
// Used by passive detection (L1 OSC, L2 idle) where re-alerting an already-
// flagged tool would be noise.
func (p *Tool) setAttention(reason string) bool {
	if p.attention.CompareAndSwap(false, true) {
		if p.onAttention != nil {
			p.onAttention(p.ID, reason)
		}
		return true
	}
	return false
}

// SignalAttention raises attention and ALWAYS notifies (not edge-gated). Used
// by explicit agent signals (`dmctl notify` → set endpoint): each discrete
// completion/waiting event must re-alert the user even if a prior unattended
// alarm is still active. The state itself stays idempotent (already-true).
//
// **다만 무엇이 사건인지는 먼저 묻는다** (묶음 N). edge 게이팅이 없는 것은
// 의도였고 그대로 남지만, 그 전제 — 훅이 오는 모든 순간이 새 사건이다 — 는
// 사실이 아니었다 (§2.7). 배경 턴의 종료와 입력 유휴 알림은 되풀이지 사건이
// 아니므로, 여기서 걸러 낸다. 걸러진 신호는 방송도 하지 않는다 (FR-ATN-4).
func (p *Tool) SignalAttention(reason string) {
	if !p.turn.AllowSignal(reason) {
		return
	}
	p.attention.Store(true)
	if p.onAttention != nil {
		p.onAttention(p.ID, reason)
	}
}

// SignalAgentEvent 는 **활동 이벤트에서 파생한** 알람이다 (FR-AEV-10).
//
// `SignalAttention` 과 나뉘어 있는 것은 판정의 재료가 하나 더 있기 때문이다 —
// 그 에이전트가 턴의 출처를 말할 수 있는가(`Signals.UserTurn`). 그 밖의 모든
// 것은 같은 자리, 같은 판정이다 (FR-AEV-11).
//
// 이것이 있어서 **활동을 보고할 수 있는 에이전트는 누구나 알람을 얻는다.**
// 종전에는 에이전트마다 `dmctl notify` 를 따로 배선해야 했고, omp 는 그 배선이
// 없어 상태만 바뀌고 알람이 울리지 않았다 (SRS §2.1).
func (p *Tool) SignalAgentEvent(state string, turnKnown bool) {
	if !p.turn.AllowActivitySignal(state, turnKnown) {
		return
	}
	p.attention.Store(true)
	if p.onAttention != nil {
		p.onAttention(p.ID, state)
	}
}

// clearAttention transitions attention→none exactly once, firing the clear
// notifier only on the transition.
func (p *Tool) clearAttention() bool {
	if p.attention.CompareAndSwap(true, false) {
		if p.onAttentionClear != nil {
			p.onAttentionClear(p.ID)
		}
		return true
	}
	return false
}

// Attend marks the tool as attended-to: disarms idle, locks re-arming, and
// clears attention.
// Invoked only via the explicit focus/clear endpoints — NOT on raw WS input,
// because xterm replies to terminal queries (cursor-position/device-attribute
// reports an agent's TUI emits) arrive as OpInput too and would spuriously
// clear a just-raised alarm. Real "user attended" is signalled by focus.
//
// FR-ATF-5: 잠금은 무장을 내리는 바로 이 자리에서 선다. 사용자가 **보기만
// 했다**는 뜻이므로, 다음 화면 갱신이 곧바로 같은 알람을 되살리면 안 된다.
func (p *Tool) Attend() {
	p.attnArmed.Store(false)
	p.attnRearmLocked.Store(true)
	p.clearAttention()
}

// AttendTyped 는 사용자가 그 도구에 **키를 눌렀을** 때의 주목이다 (FR-ATF-6).
// 보기만 한 것과 다른 점은 하나다 — 일을 시켰으므로 그 결과를 다시 기다리게
// 되고, 따라서 재무장을 열어 둔다.
func (p *Tool) AttendTyped() {
	p.attnArmed.Store(false)
	p.attnRearmLocked.Store(false)
	// FR-ATN-16: 같은 구분을 L1 명시 신호에도 준다 — 키를 눌렀으면 그다음의
	// 대기는 새 사건이다.
	p.turn.NoteAttendTyped()
	p.clearAttention()
}

// attnBusyProbe reports whether a tool has a running foreground process. It is
// a package variable so tests can substitute a deterministic probe.
// **원자적인 이유는 `attnNow` 와 같다** — 읽는 것은 쓸이(sweeper)·readPTY 이고
// 바꾸는 것은 검사다. nil 이면 진짜 판정이다.
var attnBusyProbeFn atomic.Pointer[func(*Tool) bool]

func attnBusyProbe(p *Tool) bool {
	if f := attnBusyProbeFn.Load(); f != nil {
		return (*f)(p)
	}
	return p.IsBusy()
}

// attnBusyMany 는 attnBusyProbe 를 여럿에 한 번에 답한다. 검사가 판정을 바꿔 두었으면
// 그것을 도구마다 부르고, 아니면 조회 한 번이다 (FR-OPT-8-3).
func attnBusyMany(ps []*Tool) map[*Tool]bool {
	if f := attnBusyProbeFn.Load(); f != nil {
		out := make(map[*Tool]bool, len(ps))
		for _, p := range ps {
			out[p] = (*f)(p)
		}
		return out
	}
	return busyOf(ps)
}

// SetAttnBusyProbe는 유휴 탐지와 활동 스냅샷 정리가 쓰는 전경 프로세스 검사를
// 교체하고, 이전 검사로 되돌리는 함수를 돌려준다. 다른 패키지의 테스트가 이것을
// 필요로 하는 이유는 NewDetachedTool 로 만든 도구에 프로세스가 없어 항상
// "busy 아님"으로 읽히고, 그러면 working 상태가 정리 대상이 되기 때문이다.
func SetAttnBusyProbe(f func(*Tool) bool) (restore func()) {
	prev := attnBusyProbeFn.Swap(&f)
	return func() { attnBusyProbeFn.Store(prev) }
}

// maybeIdle fires L2 (idle) attention when an armed tool has been quiet for at
// least threshold. It disarms after firing so it fires once per quiet edge;
// new output re-arms it. threshold<=0 disables L2.
//
// 발화까지 네 관문이 있고, 넷은 서로 다른 것을 묻는다 (ATTENTION_FIRING_SRS
// FR-ATF-1·3·10, FR-ATN-10). 아래는 코드가 묻는 순서다:
//
//	① 에이전트가 도는 도구인가   — 활동을 보고한 적이 있는가 (agentSeen)
//	② 턴이 진행 중인가           — 종결 뒤의 정적은 L1 이 이미 알렸다
//	③ 지금 일하는 중은 아닌가    — 단, 굳은 `working` 은 억제하지 못한다
//	④ 전경 프로세스가 있는가     — 셸 프롬프트로 돌아간 도구는 울지 않는다
//
// ① 이 없던 동안 `vim`·`less`·`top`·`ssh`·빌드 대기가 전부 울었다. ④ 만으로는
// "무언가 돌고 있다"까지밖에 말하지 못한다.
func (p *Tool) maybeIdle(now, threshold int64) {
	if threshold <= 0 || !p.attnArmed.Load() {
		return
	}
	if now-p.LastOutputAt.Load() < threshold {
		return
	}
	p.attnArmed.Store(false)
	if !p.agentSeen.Load() {
		return
	}
	// FR-ATN-10: 턴이 진행 중이 아니면 알릴 것이 없다. 종결 뒤의 정적은 L1 이
	// 이미 알린 사실이고, 시작한 적 없는 도구의 정적은 사건이 아니다.
	if !p.turn.InProgress() {
		return
	}
	if ActivityStillWorking(p.activity.Load(), now) {
		return
	}
	// 전경 탐침은 마지막이다 — 데몬 모드 대응물이 그 자리에서 RPC 를 한다
	// (FR-ATF-12, OPTIMIZE_REFACTOR_SRS FR-OPT-2-4).
	if !attnBusyProbe(p) {
		return
	}
	p.setAttention("idle")
}

// ActivityStillWorking reports whether an activity snapshot suppresses idle:
// the agent says it is working AND that word is recent enough to believe
// (FR-ATF-10). 훅이 끊긴 채 `working` 으로 굳은 활동은 억제하지 못한다 — 그것이
// 알람을 영구히 막던 자리다 (B3).
//
// 공개인 이유는 데몬 모드가 **같은 판정**을 써야 하기 때문이다 (FR-ATF-12).
// 두 벌로 적으면 한쪽만 고쳐지는 날이 온다.
func ActivityStillWorking(a *ActivityState, now int64) bool {
	return a != nil && a.State == activity.Working && now-a.UpdatedAt < AttnWorkingStale
}

// Attention reports whether the tool currently needs attention.
func (p *Tool) Attention() bool { return p.attention.Load() }

type ActivityState struct {
	State     string `json:"state"`
	Tool      string `json:"tool,omitempty"`
	Detail    string `json:"detail,omitempty"`
	UpdatedAt int64  `json:"updatedAt"`
}

type ActivitySnap struct {
	ToolID    string `json:"toolId"`
	State     string `json:"state"`
	Tool      string `json:"tool,omitempty"`
	Detail    string `json:"detail,omitempty"`
	UpdatedAt int64  `json:"updatedAt"`
}

// NoteUserPrompt 는 사용자 프롬프트로 턴이 시작되었음을 기록한다 (FR-ATN-1).
// 활동 보고와 **별도 경로**인 이유는 둘이 다른 것을 말하기 때문이다 — 활동은
// "지금 무엇을 하는가" 이고, 이것은 "이 턴이 왜 시작되었는가" 다.
func (p *Tool) NoteUserPrompt() { p.turn.NoteUserPrompt() }

func (p *Tool) SetActivity(state, tool, detail string) {
	// FR-ATF-2: 보고했다는 사실이 에이전트 표시를 세우고, `ended` 가 내린다.
	// 상태의 종류는 묻지 않는다 — 에이전트만이 활동을 보고하기 때문이다.
	p.agentSeen.Store(state != activity.Ended)
	p.turn.NoteActivity(state)
	if state == activity.Ended {
		p.activity.Store(nil) // 종료 → 카드 제거(스냅샷에서 빠짐)
	} else {
		p.activity.Store(&ActivityState{State: state, Tool: tool, Detail: detail, UpdatedAt: attnNow()})
	}
	if p.onActivity != nil {
		p.onActivity(p.ID, state, tool, detail)
	}
}

func (p *Tool) Activity() *ActivityState { return p.activity.Load() }
