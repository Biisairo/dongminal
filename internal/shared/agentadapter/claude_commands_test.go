package agentadapter

import "testing"

// V-M9-45 (M9_SRS FR-M9-45 / M9-B26): **`/` 명령은 이름만이 아니다.**
//
// `initialize` 응답은 명령마다 `description` 과 `argumentHint` 를 함께 싣는다
// (실측 2026-09-14 — 68개 중 23개가 인자 문법을 그대로 말한다). 종전에는 이름만
// 싣고 나머지를 버렸고, 그래서 화면의 제안이 `/config` 라는 맨 이름 하나였다.
//
// 사용자가 못 하는 것은 명령을 **보내는** 일이 아니라 **무엇을 보낼지 아는** 일이다.
func TestClaudeDecode_InitializeCarriesCommandHints(t *testing.T) {
	st := NewProtoState()
	p := claudeProto
	p.Handshake(LaunchOpts{}, st)
	var reqID string
	for id := range claudeExtOf(st).pending {
		reqID = id
	}
	if reqID == "" {
		t.Fatal("initialize 대기표가 없다")
	}
	evs, ok := p.Decode([]byte(`{"type":"control_response","response":{"subtype":"success",`+
		`"request_id":"`+reqID+`","response":{"commands":[`+
		`{"name":"config","description":"Set a setting by key","argumentHint":"key=value"},`+
		`{"name":"context","description":"Show current context usage","argumentHint":""},`+
		`{"name":"effort","description":"Set effort level","argumentHint":"<low|medium|high>"}]}}}`), st)
	if !ok || len(evs) != 1 || evs[0].Status == nil {
		t.Fatalf("initialize 응답이 상태가 되지 않았다: ok=%v evs=%+v", ok, evs)
	}
	cmds := evs[0].Status.Commands
	if len(cmds) != 3 {
		t.Fatalf("명령 셋이 와야 한다: %+v", cmds)
	}
	if cmds[0].Name != "config" || cmds[0].ArgumentHint != "key=value" ||
		cmds[0].Description != "Set a setting by key" {
		t.Fatalf("인자 힌트와 설명이 실리지 않았다: %+v", cmds[0])
	}
	// **인자를 받지 않는 명령은 그 자리를 비운다.** 빈 힌트를 `<args>` 로 채우면
	// 없는 문법을 지어내는 것이다 (FR-CBG-5).
	if cmds[1].ArgumentHint != "" {
		t.Fatalf("없는 인자 문법을 지어냈다: %+v", cmds[1])
	}
	if cmds[2].ArgumentHint != "<low|medium|high>" {
		t.Fatalf("선택지가 실리지 않았다: %+v", cmds[2])
	}
}

// V-M9-46 (M9_SRS FR-M9-46 — FR-M9-38 개정): **`manual` 은 CLI 가 거절한다.**
//
// 실측 2026-09-14: `set_permission_mode` 에 모르는 값을 넣으면 오류 문안이 허용
// 목록을 그대로 뱉는다 —
//
//	Cannot set permission mode: must be one of acceptEdits, auto, bypassPermissions, default, dontAsk, plan
//
// FR-M9-38 은 `claude --help` 의 choices 에 `default` 를 더해 일곱을 만들었는데,
// **기동 인자로 받는 것과 세션 중 제어로 받는 것이 같다는 보장이 없었다.**
// 순환 목록에 남겨 두면 그 차례에서 제어가 오류로 돌아온다.
func TestClaudePermissionModes_MatchWhatTheCLIAccepts(t *testing.T) {
	got := map[string]bool{}
	for _, m := range claudeProto.PermissionModes {
		got[m] = true
	}
	// 오류 문안이 목록의 진실이다.
	for _, want := range []string{"acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"} {
		if !got[want] {
			t.Errorf("CLI 가 받는 %q 가 목록에 없다", want)
		}
	}
	if got["manual"] {
		t.Error("CLI 가 거절하는 manual 이 순환 목록에 있다 (FR-M9-46)")
	}
	if len(claudeProto.PermissionModes) != 6 {
		t.Errorf("실측한 목록은 여섯이다: %v", claudeProto.PermissionModes)
	}
}
