package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/agentrec"
	"dongminal/internal/shared/statusline"
	"dongminal/internal/shared/toolhub"
)

// ACTIVITY_STATE_SUBAGENT_SRS 묶음 S·L — 서브에이전트 활동과 계정 한도 (TC-ASV-6~10).

func postActivitySet(t *testing.T, s *Server, body map[string]any) int {
	t.Helper()
	blob, _ := json.Marshal(body)
	rec := httptest.NewRecorder()
	s.apiToolActivitySet(rec, apiTestRequest(http.MethodPost, "/api/tools/activity/set", strings.NewReader(string(blob))))
	return rec.Code
}

// replayHook 은 `dmctl activity` 가 하는 일을 서버 쪽에서 되풀이한다 — 파서를 지나 main·서브에이전트 보고를 보낸다.
func replayHook(t *testing.T, s *Server, toolID, payload string) {
	t.Helper()
	a, _ := agentadapter.Get("claude")
	rep, ok := a.HookParse([]byte(payload))
	if !ok {
		return
	}
	if rep.State != "" {
		if code := postActivitySet(t, s, map[string]any{"toolId": toolID, "agent": "claude", "state": rep.State,
			"tool": rep.Tool, "detail": rep.Detail, "userPrompt": rep.UserPrompt}); code != http.StatusOK {
			t.Fatalf("main 보고 code=%d (%s)", code, payload)
		}
	}
	if sub := rep.Sub; sub != nil {
		if code := postActivitySet(t, s, map[string]any{"toolId": toolID, "agent": "claude", "agentId": sub.AgentID,
			"agentType": sub.AgentType, "state": sub.State, "tool": sub.Tool, "detail": sub.Detail}); code != http.StatusOK {
			t.Fatalf("서브에이전트 보고 code=%d (%s)", code, payload)
		}
	}
}

// TC-ASV-6: §2.2 의 실측 순서를 되풀이하면 main 은 done 으로 끝나고 서브에이전트는 done 이다.
func TestSubagentActivity_ObservedSequenceEndsDone(t *testing.T) {
	s, _, _ := statusServer(t)
	const sub = `"agent_id":"a922","agent_type":"Explore"`
	seq := []string{
		`{"hook_event_name":"UserPromptSubmit","prompt":"find parseClaudeHook"}`,
		`{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{}}`,
		`{"hook_event_name":"SubagentStart",` + sub + `}`,
		`{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_input":{}}`,
		`{"hook_event_name":"Stop","background_tasks":[{"id":"a922","status":"running"}]}`,
		`{"hook_event_name":"SubagentStop","agent_id":"a5b4","agent_type":""}`,
		`{"hook_event_name":"PreToolUse",` + sub + `,"tool_name":"Bash","tool_input":{"command":"grep -rn parse"}}`,
		`{"hook_event_name":"PostToolUse",` + sub + `,"tool_name":"Bash","tool_input":{"command":"grep -rn parse"}}`,
		`{"hook_event_name":"UserPromptSubmit","prompt":"<agent-message from=\"a922\">\nreport"}`,
		`{"hook_event_name":"SubagentStop",` + sub + `}`,
		`{"hook_event_name":"Stop","background_tasks":[]}`,
		`{"hook_event_name":"SubagentStop","agent_id":"aa98","agent_type":""}`,
		`{"hook_event_name":"Notification","notification_type":"idle_prompt","message":"Claude is waiting for your input"}`,
	}
	for _, p := range seq {
		replayHook(t, s, "p1", p)
	}
	if a := s.toolActivity("p1"); a == nil || a.State != "done" {
		t.Fatalf("main 의 마지막 상태가 done 이 아니다: %+v", a)
	}
	acts := s.subActs.list("p1", time.Now())
	if got := acts["a922"]; got.State != "done" || got.AgentType != "Explore" {
		t.Fatalf("서브에이전트 활동=%+v", acts)
	}
	if len(acts) != 1 {
		t.Fatalf("내부 에이전트가 서브에이전트 활동에 들어갔다: %+v", acts)
	}
}

// TC-ASV-7: 서브에이전트 보고는 main 활동을 바꾸지 않는다. 잘못된 상태는 400 이다 (FR-ASV-10).
func TestSubagentActivity_DoesNotTouchMain(t *testing.T) {
	s, _, p := statusServer(t)
	p.SetActivity("done", "", "")
	code := postActivitySet(t, s, map[string]any{"toolId": "p1", "agentId": "a1", "agentType": "Plan",
		"state": "working", "tool": "Read", "detail": "/a\x07.go"})
	if code != http.StatusOK {
		t.Fatalf("code=%d", code)
	}
	if a := s.toolActivity("p1"); a.State != "done" {
		t.Fatalf("main 이 바뀌었다: %+v", a)
	}
	if got := s.subActs.list("p1", time.Now())["a1"]; got.Detail != "/a.go" || got.Tool != "Read" {
		t.Fatalf("다듬기가 main 과 다르다: %+v", got)
	}
	for _, st := range []string{"idle", "ended", "bogus"} {
		if code := postActivitySet(t, s, map[string]any{"toolId": "p1", "agentId": "a1", "state": st}); code != http.StatusBadRequest {
			t.Fatalf("state=%s code=%d", st, code)
		}
	}
}

// TC-ASV-7: 상한·done 유지 기한·main ended·수거 (FR-ASV-11·12).
func TestSubagentActivityStore_Lifetime(t *testing.T) {
	var st subagentActivityStore
	t0 := time.Unix(1000, 0)
	for i := 0; i < statusline.SubagentMaxTasks+1; i++ {
		st.put("p1", fmt.Sprintf("a%02d", i), subagentActivity{State: "working"}, t0.Add(time.Duration(i)*time.Second))
	}
	got := st.list("p1", t0.Add(time.Minute))
	if len(got) != statusline.SubagentMaxTasks {
		t.Fatalf("수=%d", len(got))
	}
	if _, ok := got["a00"]; ok {
		t.Fatal("가장 오래된 것이 남았다")
	}

	var st2 subagentActivityStore
	st2.put("p1", "d", subagentActivity{State: "done"}, t0)
	if _, ok := st2.list("p1", t0.Add(agentrec.SubagentDoneKeep-time.Second))["d"]; !ok {
		t.Fatal("기한 안의 done 이 지워졌다")
	}
	if _, ok := st2.list("p1", t0.Add(agentrec.SubagentDoneKeep+time.Second))["d"]; ok {
		t.Fatal("기한이 지난 done 이 남았다")
	}

	st2.put("p1", "w", subagentActivity{State: "working"}, t0)
	st2.dropTool("p1")
	if len(st2.list("p1", t0)) != 0 {
		t.Fatal("dropTool 뒤에 남았다")
	}

	st2.put("live", "x", subagentActivity{State: "working"}, t0)
	st2.put("dead", "x", subagentActivity{State: "working"}, t0)
	if n := st2.prune(func(id string) bool { return id == "live" }); n != 1 {
		t.Fatalf("지운 수=%d", n)
	}
}

// TC-ASV-7: main 이 ended 면 그 도구의 서브에이전트 활동이 지워진다 (FR-ASV-12).
func TestSubagentActivity_MainEndedDrops(t *testing.T) {
	s, _, _ := statusServer(t)
	postActivitySet(t, s, map[string]any{"toolId": "p1", "agentId": "a1", "state": "working"})
	postActivitySet(t, s, map[string]any{"toolId": "p1", "state": "ended"})
	if got := s.subActs.list("p1", time.Now()); len(got) != 0 {
		t.Fatalf("남았다: %v", got)
	}
}

// TC-ASV-8: 서브에이전트 보고는 tool_subagent_activity 로 방송된다 (FR-ASV-13).
func TestSubagentActivity_Broadcasts(t *testing.T) {
	s, _, _ := statusServer(t)
	fb := &fakeCommandBroker{}
	s.Commands = fb
	postActivitySet(t, s, map[string]any{"toolId": "p1", "agentId": "a1", "agentType": "Plan", "state": "working", "tool": "Read", "detail": "x"})
	fb.mu.Lock()
	defer fb.mu.Unlock()
	if len(fb.published) != 1 {
		t.Fatalf("방송 수=%d", len(fb.published))
	}
	var ev struct {
		Action string         `json:"action"`
		Args   map[string]any `json:"args"`
	}
	if err := json.Unmarshal(fb.published[0], &ev); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"toolId": "p1", "agentId": "a1", "agentType": "Plan", "state": "working", "tool": "Read", "detail": "x"}
	if ev.Action != "tool_subagent_activity" || fmt.Sprint(ev.Args) != fmt.Sprint(want) {
		t.Fatalf("action=%s args=%v", ev.Action, ev.Args)
	}
}

// TC-ASV-9: statusLine 목록과 활동의 합집합, state 우선순위, description (FR-ASV-14·15·16).
func TestApiToolsActivity_MergesSubagentActivity(t *testing.T) {
	s := activityUsageServer(t)
	postSubagents(t, s, `{"toolId":"p1","tasks":[
{"id":"run","agentType":"Explore","status":"running","startTime":1000,"description":"Find\u0007 the file"},
{"id":"fin","agentType":"Plan","status":"completed","startTime":2000},
{"id":"act","agentType":"Explore","status":"running","startTime":3000}]}`)
	postActivitySet(t, s, map[string]any{"toolId": "p1", "agentId": "act", "agentType": "Explore", "state": "waiting", "tool": "Bash", "detail": "rm"})
	postActivitySet(t, s, map[string]any{"toolId": "p1", "agentId": "hookonly", "agentType": "general-purpose", "state": "working", "tool": "Read"})
	got, ok := activitySubagents(t, s)
	if !ok || len(got) != 4 {
		t.Fatalf("subagents=%v", got)
	}
	ids := []any{got[0]["id"], got[1]["id"], got[2]["id"], got[3]["id"]}
	if fmt.Sprint(ids) != "[run fin act hookonly]" {
		t.Fatalf("순서=%v", ids)
	}
	if got[0]["state"] != "working" || got[0]["description"] != "Find the file" {
		t.Fatalf("run=%v", got[0])
	}
	if got[1]["state"] != "done" {
		t.Fatalf("fin=%v", got[1])
	}
	if got[2]["state"] != "waiting" || got[2]["tool"] != "Bash" || got[2]["detail"] != "rm" {
		t.Fatalf("act=%v (활동의 상태가 statusLine 보다 앞선다)", got[2])
	}
	if got[3]["agentType"] != "general-purpose" || got[3]["state"] != "working" {
		t.Fatalf("hookonly=%v", got[3])
	}
}

// TC-ASV-9: 허용 목록이 description 을 싣는다 (FR-ASV-16).
func TestSubagentAllowlist_CarriesDescription(t *testing.T) {
	var in struct {
		Tasks []statusline.Subagent `json:"tasks"`
	}
	_ = json.Unmarshal([]byte(`{"tasks":[{"id":"a","description":"Find it"}]}`), &in)
	if len(in.Tasks) != 1 || in.Tasks[0].Description == nil || *in.Tasks[0].Description != "Find it" {
		t.Fatalf("tasks=%+v", in.Tasks)
	}
}

func pf(v float64) *float64 { return &v }

// TC-ASV-10: 계정 한도는 도구 수거 뒤에도 남고, 창 순서·등급·남은 시간이 맞다 (FR-ASV-20·21).
func TestRateLimits_ViewAndSurvivesPrune(t *testing.T) {
	s := activityUsageServer(t)
	if v := s.rateLimits.view(time.Now()); len(v) != 0 {
		t.Fatalf("보고 전 limits=%v", v)
	}
	if code := postUsage(t, s, `{"toolId":"p1","usage":{"rateLimits":{
"seven_day":{"usedPct":21,"resetsAt":1794659091},
"zeta":{"usedPct":90},
"five_hour":{"usedPct":70,"resetsAt":1794298291000},
"alpha":{"usedPct":69.9}}}}`); code != http.StatusOK {
		t.Fatalf("code=%d", code)
	}
	s.usage.prune(func(string) bool { return false })
	now := time.Unix(1794291091, 0)
	v := s.rateLimits.view(now)
	if len(v) != 1 || v[0].Agent != "claude" || v[0].ObservedAt == 0 {
		t.Fatalf("limits=%+v", v)
	}
	w := v[0].Windows
	names := []string{}
	for _, x := range w {
		names = append(names, x.Name)
	}
	if strings.Join(names, ",") != "five_hour,seven_day,alpha,zeta" {
		t.Fatalf("순서=%v", names)
	}
	if w[0].ResetsAt == nil || *w[0].ResetsAt != 1794298291 || w[0].ResetsInSec == nil || *w[0].ResetsInSec != 7200 {
		t.Fatalf("five_hour(밀리초 입력)=%+v", w[0])
	}
	if *w[1].ResetsInSec != 368000 {
		t.Fatalf("seven_day=%+v", w[1])
	}
	if w[2].ResetsInSec != nil {
		t.Fatalf("resetsAt 없는 창에 남은 시간이 섰다: %+v", w[2])
	}
	if w[0].Level != "warn" || w[1].Level != "" || w[2].Level != "" || w[3].Level != "critical" {
		t.Fatalf("등급=%q %q %q %q", w[0].Level, w[1].Level, w[2].Level, w[3].Level)
	}
	if late := s.rateLimits.view(time.Unix(1794298291+60, 0)); *late[0].Windows[0].ResetsInSec != 0 {
		t.Fatalf("지난 시각의 남은 시간=%v", *late[0].Windows[0].ResetsInSec)
	}
}

// 실제 statusLine 입력이 허용 목록을 거쳐 한도에 닿아도 창 이름이 입력 그대로다 —
// 위 시험은 이름을 직접 넣어 허용 목록의 이름 변환을 지나지 않았다.
func TestRateLimits_NamesFromStatusLineInput(t *testing.T) {
	s := activityUsageServer(t)
	u := statusline.FromInput([]byte(`{"rate_limits":{"seven_day_opus":{"used_percentage":5},
"seven_day":{"used_percentage":21},"five_hour":{"used_percentage":70}}}`))
	blob, _ := json.Marshal(map[string]any{"toolId": "p1", "usage": u})
	if code := postUsage(t, s, string(blob)); code != http.StatusOK {
		t.Fatalf("code=%d", code)
	}
	v := s.rateLimits.view(time.Now())
	if len(v) != 1 {
		t.Fatalf("limits=%+v", v)
	}
	names := []string{}
	for _, x := range v[0].Windows {
		names = append(names, x.Name)
	}
	if strings.Join(names, ",") != "five_hour,seven_day,seven_day_opus" {
		t.Fatalf("창 이름·순서=%v", names)
	}
}

func TestLimitLevel_Boundaries(t *testing.T) {
	for pct, want := range map[float64]string{69: "", 70: "warn", 89: "warn", 90: "critical", 100: "critical"} {
		if got := limitLevel(pct); got != want {
			t.Errorf("%v → %q, want %q", pct, got, want)
		}
	}
}

// TC-ASV-10: 활동 목록과 dmctl status 응답이 limits 를 싣는다 (FR-ASV-21).
func TestApiResponses_CarryLimits(t *testing.T) {
	s := activityUsageServer(t)
	rec := httptest.NewRecorder()
	s.apiToolsActivity(rec, apiTestRequest(http.MethodGet, "/api/tools/activity", nil))
	if !strings.Contains(rec.Body.String(), `"limits":[]`) {
		t.Fatalf("보고 전에도 빈 배열이어야 한다: %s", rec.Body.String())
	}
	postUsage(t, s, `{"toolId":"p1","usage":{"rateLimits":{"five_hour":{"usedPct":34,"resetsAt":4102444800}}}}`)
	rec = httptest.NewRecorder()
	s.apiToolsActivity(rec, apiTestRequest(http.MethodGet, "/api/tools/activity", nil))
	if !strings.Contains(rec.Body.String(), `"name":"five_hour"`) || !strings.Contains(rec.Body.String(), `"resetsInSec":`) {
		t.Fatalf("activity=%s", rec.Body.String())
	}
	_, out := getStatus(t, s, "id=p1")
	if l, _ := out["limits"].([]any); len(l) != 1 {
		t.Fatalf("status limits=%v", out["limits"])
	}
}

// TC-ASV-18: §2.4 의 끝 순서를 그대로·마지막 두 훅을 뒤바꿔 보고해도 서브에이전트는 done 이다 (C-10).
func TestSubagentActivity_HandbackOrderEndsDone(t *testing.T) {
	const sub = `"agent_id":"a4d7","agent_type":"Explore"`
	head := []string{
		`{"hook_event_name":"SubagentStart",` + sub + `}`,
		`{"hook_event_name":"SubagentStop",` + sub + `}`,
		`{"hook_event_name":"PreToolUse",` + sub + `,"tool_name":"SubagentHandback","tool_input":{"message":"ONE"}}`,
	}
	post := `{"hook_event_name":"PostToolUse",` + sub + `,"tool_name":"SubagentHandback","tool_input":{"message":"ONE"}}`
	stop := `{"hook_event_name":"SubagentStop",` + sub + `}`
	for name, tail := range map[string][]string{"순서대로": {post, stop}, "뒤바뀜": {stop, post}} {
		t.Run(name, func(t *testing.T) {
			s, _, _ := statusServer(t)
			for _, p := range append(append([]string{}, head...), tail...) {
				replayHook(t, s, "p1", p)
			}
			if got := s.subActs.list("p1", time.Now())["a4d7"]; got.State != "done" {
				t.Fatalf("서브에이전트 활동=%+v", got)
			}
		})
	}
}

// TC-ASV-19: 신호를 놓친 working 은 안전망이 지운다. 도는 것은 지우지 않는다 (FR-ASV-12, D-ASV-14).
func TestSubagentActivityStore_DropStale(t *testing.T) {
	t0 := time.Unix(1000, 0)
	late := t0.Add(agentrec.SubagentStaleKeep + time.Second)
	cases := []struct {
		name     string
		state    string
		now      time.Time
		mainBusy bool
		running  map[string]bool
		gone     bool
	}{
		{"조건이 모두 맞음", "working", late, false, nil, true},
		{"waiting 도 같다", "waiting", late, false, nil, true},
		{"기한 전", "working", t0.Add(agentrec.SubagentStaleKeep - time.Second), false, nil, false},
		{"main 이 바쁨", "working", late, true, nil, false},
		{"statusLine 이 running", "working", late, false, map[string]bool{"a1": true}, false},
		{"다른 서브에이전트만 running", "working", late, false, map[string]bool{"zz": true}, true},
		{"done 은 이 규칙과 무관", "done", t0.Add(agentrec.SubagentDoneKeep - time.Second), false, nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var st subagentActivityStore
			st.put("p1", "a1", subagentActivity{State: tc.state}, t0)
			st.dropStale("p1", tc.now, tc.mainBusy, tc.running)
			_, ok := st.list("p1", tc.now)["a1"]
			if ok == tc.gone {
				t.Fatalf("남음=%v, 지워져야 함=%v", ok, tc.gone)
			}
		})
	}
}

// TC-ASV-19: 조회가 안전망을 돌린다 — main 이 done 이면 오래된 working 이 목록에서 빠진다.
func TestApiToolsActivity_DropsStaleSubagent(t *testing.T) {
	for _, mainState := range []string{"done", "working"} {
		t.Run(mainState, func(t *testing.T) {
			t.Cleanup(toolhub.SetAttnBusyProbe(func(*toolhub.Tool) bool { return true }))
			s, _, p := statusServer(t)
			p.SetActivity(mainState, "", "")
			s.subActs.put("p1", "old", subagentActivity{AgentType: "web-fetch", State: "working", Tool: "SubagentHandback"},
				time.Now().Add(-agentrec.SubagentStaleKeep-time.Second))
			got, ok := activitySubagents(t, s)
			if mainState == "done" && ok {
				t.Fatalf("main 이 done 인데 남았다: %v", got)
			}
			if mainState == "working" && (!ok || len(got) != 1) {
				t.Fatalf("main 이 working 인데 지워졌다: %v", got)
			}
		})
	}
}
