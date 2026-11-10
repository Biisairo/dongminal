package main

import (
	"testing"

	"dongminal/internal/shared/toolhub"
)

type listerStub struct {
	tools []toolhub.ToolInfo
	known bool
}

func (l listerStub) ListOK() ([]toolhub.ToolInfo, bool) { return l.tools, l.known }

// AGENT_RECORD_DAEMON_SRS FR-ARD-2 (TC-ARD-1): 알람 생존 검사는 확인된 죽음만 거른다.
// 데몬이 답하지 못하는 동안 알람을 지우면, 살아 있는 도구의 알람이 화면에서 사라진다.
func TestAttnLiveProbe(t *testing.T) {
	known := attnLiveProbe(listerStub{tools: []toolhub.ToolInfo{{ID: "a"}}, known: true})
	if !known("a") {
		t.Fatal("목록에 있는 도구를 걸렀다")
	}
	if known("b") {
		t.Fatal("확인된 죽음을 거르지 않았다")
	}
	unknown := attnLiveProbe(listerStub{known: false})
	if !unknown("a") || !unknown("b") {
		t.Fatal("생존을 모르는데 알람을 걸렀다")
	}
}
