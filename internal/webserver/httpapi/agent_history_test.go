package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// V-M9-41 (M9_SRS FR-M9-41 / M9-B23) — **올리기가 기록을 읽어 로그를 채운다.**
//
// 접수한 증상: 올린 세션의 화면이 *"처음키는것과 같다"*. 세션은 이어지지만
// (`--resume`) 화면이 재생하는 것은 **우리 이벤트 로그**이고, 올리기는 새 `toolId`
// 라 그 로그가 비어 있었다.
//
// 재는 것은 배선 전부다: 훅이 실어 온 경로가 신원 옆에 남고 → 재개로 도구를 열 때
// 서버가 그 파일을 읽고 → **기존 재생 종단**이 그것을 내놓는다. 화면에 새 길을
// 내지 않는 것이 이 조항의 모양이다.
func writeTranscriptFile(t *testing.T, lines ...string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "sid-h.jsonl")
	if err := os.WriteFile(p, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestAgentAPI_LiftReplaysTheTranscript(t *testing.T) {
	s, _, _ := directAgentServer(t)
	tp := writeTranscriptFile(t,
		`{"type":"user","message":{"content":"과거의 물음"}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"과거의 답"}]}}`,
		`{"type":"attachment","content":{"type":"ai-title"}}`,
	)
	// 훅이 실어 온 신원 — 셸에서 도는 세션이다 (FR-M9-32 의 경로).
	s.noteAgentSession("term-1", "sid-h", claudeID, tp)

	id := createAgent(t, s, "&resume=sid-h")
	st, kinds, truncated := agentEvents(t, s, id, 0)
	if truncated {
		t.Fatalf("상한 안인데 잘렸다고 했다: %v", kinds)
	}
	if len(kinds) < 2 || kinds[0] != "user" || kinds[1] != "message" {
		t.Fatalf("기록이 재생되지 않았다: %v", kinds)
	}
	if st["history"] != "loaded" {
		t.Fatalf("기록을 읽은 사실이 상태에 없다: %v", st["history"])
	}
	// 경로는 브라우저로 나가지 않는다 — 서버가 로컬에서 쓰는 값이다 (NFR-4 개정).
	blob, _ := json.Marshal(st)
	if strings.Contains(string(blob), tp) {
		t.Fatalf("전사본 경로가 재생 응답으로 샜다: %s", blob)
	}
}

// V-M9-41 ③ (FR-APS-4): **읽지 못하면 그 사실이 상태에 실린다.**
//
// 조용히 비면 사용자는 세션이 이어지지 않은 줄 안다 — 그것이 접수한 증상 그대로다.
// 그래서 "묻고 못 읽었다" 는 "묻지 않았다" 와 다른 값이어야 한다.
func TestAgentAPI_LiftWithoutTranscriptSaysSo(t *testing.T) {
	s, _, _ := directAgentServer(t)
	// 신원은 있는데 경로가 없다 — 서버가 다시 선 뒤 활동 훅만 닿은 자리다.
	s.noteAgentSession("term-1", "sid-none", claudeID, "")
	id := createAgent(t, s, "&resume=sid-none")
	st, kinds, _ := agentEvents(t, s, id, 0)
	if st["history"] != "unavailable" {
		t.Fatalf("읽지 못한 사실이 상태에 없다: %v", st["history"])
	}
	for _, k := range kinds {
		if k == "user" || k == "message" {
			t.Fatalf("없는 기록에서 대화가 나왔다: %v", kinds)
		}
	}

	// 재개가 아닌 새 세션은 **묻지 않았다** — 빈 화면이 정상이고 문장을 붙이지 않는다.
	fresh := createAgent(t, s, "")
	st, _, _ = agentEvents(t, s, fresh, 0)
	if _, ok := st["history"]; ok {
		t.Fatalf("묻지 않은 것에 답했다: %v", st["history"])
	}
}

// V-M9-41 (M9_SRS FR-M9-41): **세션 id 는 어느 에이전트의 것인지 말하지 않는다.**
//
// 전사본의 형식은 에이전트마다 다르다 (`ParseHistory` 가 어댑터에 있는 이유가 그것이다).
// 그런데 세션 id 는 그 형식을 말하지 않는 값이라, id 만으로 경로를 고르면 **다른
// 에이전트의 전사본**을 이 어댑터의 파서에 넘기는 길이 열린다.
//
// 올리기 경로에서는 `agent` 와 `resume` 이 같은 응답에서 함께 오므로 실제로는
// 어긋나지 않는다. 그것은 **호출자의 예의**이지 이 함수의 보장이 아니다 — 보장을
// 여기 세운다.
func TestAgentAPI_HistoryNeedsTheAgentToMatch(t *testing.T) {
	s, _, _ := directAgentServer(t)
	tp := writeTranscriptFile(t, `{"type":"user","message":{"content":"남의 기록"}}`)
	// 같은 세션 id 를 **다른 에이전트**가 들고 있다.
	s.noteAgentSession("term-other", "sid-shared", "codex", tp)

	id := createAgent(t, s, "&resume=sid-shared")
	st, kinds, _ := agentEvents(t, s, id, 0)
	if st["history"] != "unavailable" {
		t.Fatalf("남의 전사본을 읽었다고 했다: %v", st["history"])
	}
	for _, k := range kinds {
		if k == "user" || k == "message" {
			t.Fatalf("다른 에이전트의 기록이 화면에 실렸다: %v", kinds)
		}
	}

	// 같은 에이전트가 들고 있으면 읽는다 — 막는 것은 어긋남뿐이다.
	s.noteAgentSession("term-mine", "sid-mine", claudeID, tp)
	id2 := createAgent(t, s, "&resume=sid-mine")
	st2, kinds2, _ := agentEvents(t, s, id2, 0)
	if st2["history"] != "loaded" || len(kinds2) == 0 || kinds2[0] != "user" {
		t.Fatalf("같은 에이전트의 기록을 읽지 못했다: %v %v", st2["history"], kinds2)
	}
}

// V-M9-41 (NFR-4 개정): **경로는 서버 안에서만 산다.**
//
// `/api/agent/session` 은 올리기의 재료를 주는 자리이고, 프론트는 그 답으로 버튼을
// 세운다. 브라우저는 파일을 열지 않으므로 경로를 알 이유가 없다.
func TestApiAgentSessionOf_DoesNotLeakTranscriptPath(t *testing.T) {
	s, _, _ := directAgentServer(t)
	const tp = "/tmp/leak/sid-x.jsonl"
	s.noteAgentSession("term-2", "sid-x", claudeID, tp)
	rec := httptest.NewRecorder()
	s.apiAgentSessionOf(rec, apiTestRequest(http.MethodGet, "/api/agent/session?tool=term-2", nil))
	if rec.Code != 200 {
		t.Fatalf("상태: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), tp) || strings.Contains(rec.Body.String(), "transcript") {
		t.Fatalf("전사본 경로가 브라우저로 샜다: %s", rec.Body.String())
	}
}
