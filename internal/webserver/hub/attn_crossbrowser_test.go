package hub

import (
	"bytes"
	"testing"
)

// PANE_ATTENTION_NOTIFY_SRS FR-PAN-11 (필수): 한 브라우저의 해제는 **다른
// 브라우저에도 전파**된다. 전파의 유일한 길은 `tool_attention_clear` 방송이다.
//
// 접수(2026-09-22): *"알람을 확인하면 어디서 확인하든 다른 브라우저 알람도 전부
// 제거되어야 하는데 그대로 유지된다."*
//
// 이 파일이 가르는 것은 하나다 — **방송이 서버에서 나가는가.** 나간다면 결함은
// 받는 쪽(클라이언트)이고, 나가지 않는다면 여기다.

func clearedFor(fb *fakeBroker, toolID string) int {
	n := 0
	for _, p := range fb.sent {
		if bytes.Contains(p, []byte(`"action":"tool_attention_clear"`)) &&
			bytes.Contains(p, []byte(`"toolId":"`+toolID+`"`)) {
			n++
		}
	}
	return n
}

// 보기만 한 해제(typed=false) — 알림 센터의 x, 그리고 pointerdown.
func TestAttnClear_BroadcastsOnAttend(t *testing.T) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	tr.NoteUserPrompt("t1")
	tr.SignalAttention("t1", "done")

	tr.Attend("t1")

	if n := clearedFor(fb, "t1"); n != 1 {
		t.Fatalf("해제 방송 %d회 — 1회여야 한다 (FR-PAN-11): %q", n, fb.sent)
	}
}

// 키를 누른 해제(typed=true) — 같은 종단, 같은 전파여야 한다 (FR-ATA-9).
func TestAttnClear_BroadcastsOnAttendTyped(t *testing.T) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	tr.NoteUserPrompt("t1")
	tr.SignalAttention("t1", "done")

	tr.AttendTyped("t1")

	if n := clearedFor(fb, "t1"); n != 1 {
		t.Fatalf("해제 방송 %d회 — 1회여야 한다 (FR-PAN-11): %q", n, fb.sent)
	}
}

// 일괄 해제도 창마다 전파된다 (FR-PAN-17).
func TestAttnClearAll_BroadcastsEach(t *testing.T) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	for _, id := range []string{"t1", "t2"} {
		tr.NoteUserPrompt(id)
		tr.SignalAttention(id, "done")
	}

	tr.ClearAllAttention()

	for _, id := range []string{"t1", "t2"} {
		if n := clearedFor(fb, id); n != 1 {
			t.Fatalf("%s 해제 방송 %d회 — 1회여야 한다 (FR-PAN-17): %q", id, n, fb.sent)
		}
	}
}

// **알람이 두 번 선 뒤의 해제.** 같은 도구에 신호가 거듭 오면 `Store(true)` 가
// 매번 방송을 낸다(에지가 아니다). 그 뒤의 해제 한 번이 여전히 방송을 내는지 —
// 즉 set 과 clear 의 비대칭이 전파를 삼키지 않는지 잰다.
func TestAttnClear_BroadcastsAfterRepeatedSignals(t *testing.T) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	tr.NoteUserPrompt("t1")
	tr.SignalAttention("t1", "done")
	tr.NoteUserPrompt("t1")
	tr.SignalAttention("t1", "done")

	tr.Attend("t1")

	if n := clearedFor(fb, "t1"); n != 1 {
		t.Fatalf("해제 방송 %d회 — 1회여야 한다: %q", n, fb.sent)
	}
}

// **이미 해제된 것을 또 해제**하면 방송하지 않는다 (NFR-PAN-3 에지 규약). 이것이
// 참이어야 하는 이유는 폭주 방지이고, 동시에 이 규약이 접수의 후보이기도 하다 —
// 서버가 먼저 꺼져 있으면 뒤따르는 해제는 전파되지 않는다.
func TestAttnClear_SecondAttendIsSilent(t *testing.T) {
	fb := &fakeBroker{}
	tr := NewAttnTracker(fb, 0)
	tr.NoteUserPrompt("t1")
	tr.SignalAttention("t1", "done")

	tr.Attend("t1")
	tr.Attend("t1")

	if n := clearedFor(fb, "t1"); n != 1 {
		t.Fatalf("해제 방송 %d회 — 에지에서만 1회여야 한다 (NFR-PAN-3): %q", n, fb.sent)
	}
}
