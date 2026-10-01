package toolhub

import (
	"sync"
	"testing"
)

// ATTENTION_FIRING_SRS §3.4.7 의 직접 모드 검증 — 에이전트 도구의 OSC 알림
// (FR-ATN-22~25). 데몬 모드는 `hub/attn_agent_osc_test.go` 가 같은 항목을 잰다.

// claudeIdleOSC 는 §1.11 에서 격리 PTY 로 포착한 바이트 그대로다.
const claudeIdleOSC = "\x1b]777;notify;Claude Code;Claude is waiting for your input\x07"

// V-ATN-18: 에이전트 도구가 내보낸 알림 시퀀스는 알람이 아니다. 같은 사건은 훅
// 경로가 묶음 N 의 판정을 거쳐 이미 알린다 (FR-ATN-22).
func TestTool_AgentOSC_DoesNotFire(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("agent", &mu, &attn, &clear)

	p.NoteUserPrompt()
	p.SetActivity("working", "", "")
	p.SetActivity("done", "", "")
	p.observeOutputAt([]byte(claudeIdleOSC), 1)

	if len(attn) != 0 || p.Attention() {
		t.Fatalf("에이전트 도구의 OSC 가 알람이 되었다: %v", attn)
	}
}

// V-ATN-19: 에이전트가 아닌 도구의 시퀀스는 그대로 알람이다 (FR-ATN-23).
func TestTool_PlainOSC_StillFires(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("plain", &mu, &attn, &clear)

	p.observeOutputAt([]byte(claudeIdleOSC), 1)

	if len(attn) != 1 || attn[0] != "plain:signaled" {
		t.Fatalf("에이전트가 아닌 도구의 OSC 가 알람이 되지 않았다: %v", attn)
	}
}

// V-ATN-20: `ended` 뒤의 같은 도구는 에이전트가 아니다 (FR-ATN-23).
func TestTool_OSCAfterEnded_Fires(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("agent", &mu, &attn, &clear)

	p.SetActivity("working", "", "")
	p.SetActivity("ended", "", "")
	p.observeOutputAt([]byte(claudeIdleOSC), 1)

	if len(attn) != 1 || attn[0] != "agent:signaled" {
		t.Fatalf("세션이 끝난 도구의 OSC 가 알람이 되지 않았다: %v", attn)
	}
}

// V-ATN-21: 거르는 것은 결과의 사용뿐이다 — 에이전트 도구에서도 이월은 남는다
// (FR-ATN-24). 앞조각이 에이전트일 때, 뒷조각이 `ended` 뒤에 온다.
func TestTool_AgentOSC_KeepsCarry(t *testing.T) {
	var mu sync.Mutex
	var attn, clear []string
	p := newAttnPane("agent", &mu, &attn, &clear)

	half := len(claudeIdleOSC) / 2
	p.SetActivity("working", "", "")
	p.observeOutputAt([]byte(claudeIdleOSC[:half]), 1)
	p.SetActivity("ended", "", "")
	p.observeOutputAt([]byte(claudeIdleOSC[half:]), 2)

	if len(attn) != 1 || attn[0] != "agent:signaled" {
		t.Fatalf("이월이 버려졌다: %v", attn)
	}
}
