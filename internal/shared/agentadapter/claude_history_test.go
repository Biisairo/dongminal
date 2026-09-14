package agentadapter

import (
	"encoding/json"
	"testing"
)

// V-M9-41 ① (M9_SRS FR-M9-41 / M9-B23): **어댑터가 아는 것은 전사본 한 줄의 뜻이다.**
//
// 재는 것은 `ParseUsage` 와 같은 자리다 (FR-AAC-11) — 줄을 고르고·자르는 일은
// 호출자의 몫이고, 여기서는 한 줄이 어떤 이벤트가 되는가만 본다.
func TestClaudeParseHistory_LineMeanings(t *testing.T) {
	ad, err := Get("claude")
	if err != nil {
		t.Fatalf("claude 어댑터: %v", err)
	}
	if ad.ParseHistory == nil {
		t.Fatal("claude 는 전사본을 읽는다 — ParseHistory 가 nil 이면 그 선언이 없다")
	}

	// ① assistant 의 본문은 **블록 배열 그대로** 간다 (FR-APS-7 의 어휘 셋).
	evs, ok := ad.ParseHistory(`{"type":"assistant","message":{"model":"m",` +
		`"content":[{"type":"thinking","thinking":"생각"},{"type":"text","text":"답"}]}}`)
	if !ok || len(evs) != 1 || evs[0].Kind != EvMessage {
		t.Fatalf("assistant 줄이 메시지가 되지 않았다: ok=%v evs=%+v", ok, evs)
	}
	var blocks []map[string]any
	if err := json.Unmarshal(evs[0].Message, &blocks); err != nil || len(blocks) != 2 {
		t.Fatalf("블록이 그대로 실리지 않았다: %v %s", err, evs[0].Message)
	}

	// ② 사용자가 친 줄은 EvUser 다 (content 가 문자열).
	evs, ok = ad.ParseHistory(`{"type":"user","message":{"content":"안녕"}}`)
	if !ok || len(evs) != 1 || evs[0].Kind != EvUser || evs[0].Text != "안녕" {
		t.Fatalf("사용자 줄이 EvUser 가 되지 않았다: ok=%v evs=%+v", ok, evs)
	}

	// ③ 도구 결과는 EvToolEnd 다 — 라이브 스트림과 **같은 이벤트**여야 화면이 갈리지 않는다.
	evs, ok = ad.ParseHistory(`{"type":"user","message":{"content":[{"type":"tool_result",` +
		`"tool_use_id":"tu-1","content":"결과","is_error":true}]}}`)
	if !ok || len(evs) != 1 || evs[0].Kind != EvToolEnd || evs[0].ToolUseID != "tu-1" ||
		evs[0].Text != "결과" || !evs[0].IsError {
		t.Fatalf("도구 결과가 EvToolEnd 가 되지 않았다: ok=%v evs=%+v", ok, evs)
	}

	// ④ 전사본에만 있는 살림살이 줄은 **모르는 것**이다 — 화면에 옮기지 않는다.
	for _, line := range []string{
		`{"type":"attachment","content":{"type":"ai-title"}}`,
		`{"type":"file-history-snapshot","snapshot":{}}`,
		`{"type":"summary","summary":"요약"}`,
		`not json`,
		``,
	} {
		if evs, ok := ad.ParseHistory(line); ok || len(evs) != 0 {
			t.Fatalf("살림살이 줄이 이벤트가 됐다 (%s): ok=%v evs=%+v", line, ok, evs)
		}
	}
}

// V-M9-41 ③ (FR-APS-4): **읽지 못하는 어댑터는 선언으로 말한다.**
//
// `nil` 은 "이 에이전트의 기록은 읽지 않는다" 이며 빈 함수와 다르다 — 빈 함수는
// "읽었는데 없다" 로 읽힌다. 그 구분이 화면의 문장을 가른다.
func TestParseHistory_AbsenceIsDeclared(t *testing.T) {
	for _, id := range []string{"codex", "omp"} {
		ad, err := Get(id)
		if err != nil {
			t.Fatalf("%s 어댑터: %v", id, err)
		}
		if ad.ParseHistory != nil {
			t.Fatalf("%s 의 기록 형식은 아직 재지 않았다 — 빈 선언으로 두어야 한다", id)
		}
	}
}
