package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 묶음 V — Run 시각화 종단의 검증 (ORCHESTRATION_V2_SRS §3.5, V-RVZ-4~11).

// graphOf calls GET /api/runs/{id}/graph and returns the status, the decoded
// body, and the **raw** bytes. 원문이 필요한 이유는 V-RVZ-10 이다 — 새면 안 되는
// 것을 찾는 검사는 구조를 훑는 것이 아니라 바이트를 봐야 한다.
func graphOf(t *testing.T, s *Server, runID string) (int, map[string]any, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/runs/"+runID+"/graph", nil))
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out, rec.Body.String()
}

// graphList pulls one array field out of the graph response.
func graphList(t *testing.T, body map[string]any, key string) []map[string]any {
	t.Helper()
	raw, _ := json.Marshal(body[key])
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("%s 가 배열이 아니다: %v", key, err)
	}
	return out
}

// V-RVZ-9: 없는 Run 은 404 다. 빈 그래프로 답하면 탭이 "이 Run 은 더 이상 없다"를
// 그릴 근거가 사라진다 (FR-RVZ-9).
func TestApiRunGraph_UnknownRunIs404(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	code, out, _ := graphOf(t, s, "없는-run")
	if code != http.StatusNotFound {
		t.Fatalf("want 404, got %d (%+v)", code, out)
	}
	if out["error"] != "unknown_run" {
		t.Fatalf("거부 사유를 뭉뚱그렸다: %+v", out)
	}
}

// V-RVZ-10 / NFR-RVZ-3: 응답에 brief 전문·보고 본문·transcript 경로가 없다.
func TestApiRunGraph_LeaksNoBriefSummaryOrTranscript(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	s.Runs = storeWithFixture(t, `{
	  "schemaVersion": 1,
	  "runs": [{
	    "id": "run-1", "short": "run-1", "objective": "합평",
	    "projection": "dedicated-window", "isolation": "per-member",
	    "state": "open", "epoch": "epoch-test", "coordinatorToolId": "tool-a",
	    "members": [
	      {"id":"m-a","runId":"run-1","role":"작가","agent":"claude","toolId":"tool-a",
	       "brief":"BRIEF-비밀-본문","summary":"SUMMARY-비밀-본문","sessionId":"SESSION-비밀-경로",
	       "handoffSummary":"HANDOFF-비밀-본문","filesModified":["/secret/path.go"],
	       "state":"done","outcome":"succeeded","reportedAt":10,"createdAt":1,
	       "worktree":{"path":"/w/a1b2","branch":"run/a1b2","base":"BASE-비밀"}}
	    ]
	  }]
	}`)
	code, body, raw := graphOf(t, s, "run-1")
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d (%+v)", code, body)
	}
	for _, forbidden := range []string{
		"BRIEF-비밀-본문", "SUMMARY-비밀-본문", "SESSION-비밀-경로",
		"HANDOFF-비밀-본문", "/secret/path.go", "BASE-비밀",
		"brief", "summary", "sessionId", "handoffSummary", "filesModified",
	} {
		if strings.Contains(raw, forbidden) {
			t.Fatalf("응답이 %q 를 실었다 (NFR-RVZ-3): %s", forbidden, raw)
		}
	}
	// 그리는 데 필요한 것은 남아야 한다 — 없애는 것이 목적이 아니다.
	m := graphList(t, body, "members")[0]
	if m["role"] != "작가" || m["outcome"] != "succeeded" {
		t.Fatalf("그릴 사실까지 사라졌다: %+v", m)
	}
	wt, _ := m["worktree"].(map[string]any)
	if wt == nil || wt["branch"] != "run/a1b2" {
		t.Fatalf("worktree 표기가 없다: %+v", m)
	}
}

// V-RVZ-5: 헤드리스 2 / 일반 2 가 그대로 구분돼 나온다.
func TestApiRunGraph_CarriesHeadlessPerMember(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	s.Runs = storeWithFixture(t, `{
	  "schemaVersion": 1,
	  "runs": [{
	    "id": "run-1", "short": "run-1", "objective": "팬아웃",
	    "projection": "inline", "isolation": "none",
	    "state": "open", "epoch": "epoch-test", "coordinatorToolId": "tool-x",
	    "members": [
	      {"id":"m-1","runId":"run-1","role":"r1","agent":"claude","toolId":"t1","tabId":"tab-1","state":"working","createdAt":1},
	      {"id":"m-2","runId":"run-1","role":"r2","agent":"claude","toolId":"t2","tabId":"tab-2","state":"working","createdAt":2},
	      {"id":"m-3","runId":"run-1","role":"r3","agent":"claude","toolId":"t3","headless":true,"state":"working","createdAt":3},
	      {"id":"m-4","runId":"run-1","role":"r4","agent":"claude","toolId":"t4","headless":true,"state":"working","createdAt":4}
	    ]
	  }]
	}`)
	code, body, _ := graphOf(t, s, "run-1")
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	members := graphList(t, body, "members")
	if len(members) != 4 {
		t.Fatalf("멤버 4명이어야 한다: %+v", members)
	}
	headless := 0
	for _, m := range members {
		if v, _ := m["headless"].(bool); v {
			headless++
		}
	}
	if headless != 2 {
		t.Fatalf("헤드리스 2명이어야 한다, got %d: %+v", headless, members)
	}
}

// V-RVZ-6: 컨텍스트 등급이 노드까지 전달된다. V-RVZ-7: 승계 관계가 양방향으로
// 남고, 넘긴 멤버의 상태가 도구 생존에 지워지지 않는다.
func TestApiRunGraph_CarriesContextLevelAndSuccession(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	s.Runs = storeWithFixture(t, `{
	  "schemaVersion": 1,
	  "runs": [{
	    "id": "run-1", "short": "run-1", "objective": "장기전",
	    "projection": "inline", "isolation": "none",
	    "state": "open", "epoch": "epoch-test", "coordinatorToolId": "tool-a",
	    "members": [
	      {"id":"m-old","runId":"run-1","role":"작가","agent":"claude","toolId":"t-dead",
	       "state":"succeeded","succeededBy":"m-new","contextRatio":0.93,"contextLevel":"critical",
	       "compactCount":2,"createdAt":1},
	      {"id":"m-new","runId":"run-1","role":"작가","agent":"claude","toolId":"tool-b",
	       "state":"working","succeededFrom":"m-old","contextRatio":0.1,"contextLevel":"ok","createdAt":5}
	    ]
	  }]
	}`)
	code, body, _ := graphOf(t, s, "run-1")
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	members := graphList(t, body, "members")
	old, next := members[0], members[1]
	if old["contextLevel"] != "critical" || old["compactCount"] != float64(2) {
		t.Fatalf("컨텍스트 관측이 전달되지 않았다 (V-RVZ-6): %+v", old)
	}
	// 도구(t-dead)는 죽어 있다. 그래도 승계는 기록이 이긴다 — lost 로 접히면
	// 승계 화살표를 그릴 근거가 사라진다.
	if old["state"] != "succeeded" || old["succeededBy"] != "m-new" {
		t.Fatalf("승계된 멤버의 상태·연결이 어긋난다 (V-RVZ-7): %+v", old)
	}
	if next["succeededFrom"] != "m-old" {
		t.Fatalf("승계 역참조가 없다 (V-RVZ-7): %+v", next)
	}
	// 승계는 타임라인에서도 member_add 가 아니라 succeed 다.
	kinds := map[string]int{}
	for _, e := range graphList(t, body, "timeline") {
		k, _ := e["kind"].(string)
		kinds[k]++
	}
	if kinds["succeed"] != 1 || kinds["member_add"] != 1 || kinds["run_start"] != 1 {
		t.Fatalf("타임라인이 어긋난다: %+v", kinds)
	}
}

// V-RVZ-11 / FR-RVZ-14: 501건을 보내면 그래프는 500건을 낸다. 엣지는 (from,to)
// 로 접히고 방향을 잃지 않는다.
func TestApiRunGraph_CapsMessagesAndFoldsEdges(t *testing.T) {
	s, _, store, _ := runsServer(t, "tool-a")
	fb := &fakeCommandBroker{}
	s.Commands = fb
	runID := startRun(t, s) // 조정자 = tool-a
	if code, out := postRun(t, s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"작가","agent":"claude","id":"tool-b"}`); code != http.StatusOK {
		t.Fatalf("멤버 등록 실패 %d (%+v)", code, out)
	}
	member, ok := store.MemberByTool("tool-b")
	if !ok {
		t.Fatal("멤버를 찾지 못했다")
	}

	// 조정자(tool-a) → 멤버(tool-b) 를 501번 실제로 보낸다.
	for i := 0; i <= 500; i++ {
		code, out := postRun(t, s, "/api/tools/message",
			`{"to":"tool-b","from":"tool-a","message":"ping"}`)
		if code != http.StatusOK {
			t.Fatalf("msg %d 실패 %d (%+v)", i, code, out)
		}
	}
	// 멤버 → 조정자 한 건. 방향이 접히지 않는 것을 여기서 본다.
	if code, out := postRun(t, s, "/api/tools/message",
		`{"to":"tool-a","from":"tool-b","message":"pong"}`); code != http.StatusOK {
		t.Fatalf("역방향 msg 실패 %d (%+v)", code, out)
	}

	code, body, _ := graphOf(t, s, runID)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	msgs := graphList(t, body, "messages")
	if len(msgs) != 500 {
		t.Fatalf("최근 500건이어야 한다, got %d", len(msgs))
	}
	if msgs[0]["kind"] != "agent" || msgs[0]["size"] != float64(len("ping")) {
		t.Fatalf("이벤트가 어긋난다: %+v", msgs[0])
	}
	edges := graphList(t, body, "edges")
	if len(edges) != 2 {
		t.Fatalf("방향이 접혔다 — 엣지 2개여야 한다: %+v", edges)
	}
	forward, reverse := edges[0], edges[1]
	if forward["from"] != "coordinator" || forward["to"] != member.ID {
		t.Fatalf("조정자→멤버 엣지가 어긋난다: %+v", forward)
	}
	if reverse["from"] != member.ID || reverse["to"] != "coordinator" {
		t.Fatalf("멤버→조정자 엣지가 어긋난다: %+v", reverse)
	}
	// 잘린 뒤의 count 는 남아 있는 건수다 — 그래프가 그리는 것은 보관된 사실이다.
	if forward["count"] != float64(499) || reverse["count"] != float64(1) {
		t.Fatalf("엣지 집계가 어긋난다: %+v / %+v", forward, reverse)
	}
	if lastAt, _ := forward["lastAt"].(float64); lastAt == 0 {
		t.Fatalf("lastAt 이 비었다: %+v", forward)
	}
}

// V-RVZ-4 / FR-RVZ-16: 메시지가 기록되면 run_changed 를 쏜다. 대시보드는 이것으로
// 갱신하며 폴링하지 않는다.
func TestApiToolMessage_BroadcastsRunChanged(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	fb := &fakeCommandBroker{}
	s.Commands = fb
	runID := startRun(t, s)
	if code, out := postRun(t, s, "/api/runs/members",
		`{"runId":"`+runID+`","role":"작가","agent":"claude","id":"tool-b"}`); code != http.StatusOK {
		t.Fatalf("멤버 등록 실패 %d (%+v)", code, out)
	}
	before := len(publishedActions(fb, "run_changed"))

	if code, out := postRun(t, s, "/api/tools/message",
		`{"to":"tool-b","from":"tool-a","message":"작업 시작"}`); code != http.StatusOK {
		t.Fatalf("msg 실패 %d (%+v)", code, out)
	}
	sent := publishedActions(fb, "run_changed")
	if len(sent) != before+1 {
		t.Fatalf("run_changed 가 한 번 나가야 한다: %d → %d", before, len(sent))
	}
	args, _ := sent[len(sent)-1]["args"].(map[string]any)
	if args == nil || args["runId"] != runID {
		t.Fatalf("payload 가 runId 를 담지 않았다: %+v", sent[len(sent)-1])
	}
}

// FR-RVZ-14: 팀 밖 통신은 기록하지 않고 아무도 깨우지 않는다. 배달 자체는
// 성공한다 — 기록은 관측이지 관문이 아니다.
func TestApiToolMessage_IgnoresTrafficOutsideAnyRun(t *testing.T) {
	s, _, store, _ := runsServer(t, "tool-a")
	fb := &fakeCommandBroker{}
	s.Commands = fb
	runID := startRun(t, s) // 멤버가 하나도 없는 Run

	if code, out := postRun(t, s, "/api/tools/message",
		`{"to":"tool-b","from":"tool-a","message":"안녕"}`); code != http.StatusOK {
		t.Fatalf("배달까지 막혔다 %d (%+v)", code, out)
	}
	rec, _ := store.Get(runID)
	if len(rec.Messages) != 0 {
		t.Fatalf("팀 밖 통신이 기록됐다: %+v", rec.Messages)
	}
	if n := len(publishedActions(fb, "run_changed")); n != 0 {
		t.Fatalf("기록도 없는데 대시보드를 깨웠다: %d건", n)
	}
}

// publishedActions returns the decoded payloads whose action matches.
func publishedActions(fb *fakeCommandBroker, action string) []map[string]any {
	fb.mu.Lock()
	defer fb.mu.Unlock()
	var out []map[string]any
	for _, blob := range fb.published {
		var m map[string]any
		if json.Unmarshal(blob, &m) == nil && m["action"] == action {
			out = append(out, m)
		}
	}
	return out
}
