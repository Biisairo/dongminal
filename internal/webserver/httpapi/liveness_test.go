package httpapi

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"dongminal/internal/webserver/domain/run"
)

// AGENT_RECORD_DAEMON_SRS 단계 4 (§3.4a) — 생존 판정의 세 값.
//
// "모른다"(데몬이 목록에 답하지 못함)를 "죽었다"로 읽으면 살아 있는 Run 이 지워지고
// 기록이 사라진다 (§2.2). 아래 시험의 "모른다"는 `fakeUnknownHub` 다.

func unknownTools(s *Server) {
	s.Tools = &fakeUnknownHub{newFakePaneHub()}
}

// TC-ARD-1 (FR-ARD-1).
func TestToolLivenessThreeValues(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	if got := s.toolLiveness("tool-a"); got != livenessAlive {
		t.Fatalf("살아 있는 도구=%q", got)
	}
	if got := s.toolLiveness("tool-gone"); got != livenessDead {
		t.Fatalf("목록에 없는 도구=%q", got)
	}
	unknownTools(s)
	for _, id := range []string{"tool-a", "tool-gone"} {
		if got := s.toolLiveness(id); got != livenessUnknown {
			t.Fatalf("데몬이 답하지 못할 때 %s=%q want unknown", id, got)
		}
	}
}

// TC-ARD-2 (FR-ARD-2·5): 모르는 동안에는 Run·사용량·서브에이전트를 지우지 않는다.
// 죽음이 확인되면 그때 지운다.
func TestReapTickKeepsRecordsWhileUnknown(t *testing.T) {
	s, _, store, _ := runsServer(t, "tool-a")
	rec := startRunFor(t, store, "조정자 죽음", "tool-gone")
	now := time.Now()
	s.usage.put("tool-gone", toolUsage{})
	s.subagents.put("tool-gone", nil, now)
	s.subActs.put("tool-gone", "x", subagentActivity{State: "working"}, now)

	known := s.Tools
	unknownTools(s)
	s.reapTick()
	if _, ok := store.Get(rec.ID); !ok {
		t.Fatal("생존을 모르는 조정자의 Run 을 지웠다 (FR-ARD-5)")
	}
	if _, ok := s.usage.get("tool-gone"); !ok {
		t.Fatal("생존을 모르는 도구의 사용량을 지웠다")
	}
	if _, ok := s.subagents.get("tool-gone", now); !ok {
		t.Fatal("생존을 모르는 도구의 서브에이전트 목록을 지웠다")
	}
	if len(s.subActs.list("tool-gone", now)) != 1 {
		t.Fatal("생존을 모르는 도구의 서브에이전트 활동을 지웠다")
	}

	s.Tools = known
	s.reapTick()
	if _, ok := store.Get(rec.ID); ok {
		t.Fatal("조정자가 확인된 죽음인 Run 이 남았다")
	}
	if _, ok := s.usage.get("tool-gone"); ok {
		t.Fatal("죽은 도구의 사용량이 남았다")
	}
	if _, ok := s.subagents.get("tool-gone", now); ok {
		t.Fatal("죽은 도구의 서브에이전트 목록이 남았다")
	}
	if len(s.subActs.list("tool-gone", now)) != 0 {
		t.Fatal("죽은 도구의 서브에이전트 활동이 남았다")
	}
}

// TC-ARD-4 (FR-ARD-4): Run 마다 liveness 를 계산해 싣는다.
func TestRunViewLiveness(t *testing.T) {
	s, _, store, _ := runsServer(t, "tool-a")
	alive := startRunFor(t, store, "조정자 삶", "tool-a")
	gone := startRunFor(t, store, "모두 죽음", "tool-gone")
	if _, err := store.AddMember(gone.ID, run.MemberSpec{Role: "w", Agent: "claude", ToolID: "tool-gone-2"}); err != nil {
		t.Fatal(err)
	}
	memberAlive := startRunFor(t, store, "멤버만 삶", "tool-gone-3")
	if _, err := store.AddMember(memberAlive.ID, run.MemberSpec{Role: "w", Agent: "claude", ToolID: "tool-b"}); err != nil {
		t.Fatal(err)
	}
	empty := startRunFor(t, store, "도구 없음", "")
	closed := startRunFor(t, store, "닫힘", "tool-a")
	if _, _, err := store.Close(closed.ID, true); err != nil {
		t.Fatal(err)
	}

	want := map[string]string{
		alive.ID: "open", gone.ID: "gone", memberAlive.ID: "open", empty.ID: "unknown", closed.ID: "",
	}
	for id, w := range want {
		rec, _ := store.Get(id)
		if got := s.viewOf(rec).Liveness; got != w {
			t.Errorf("%s liveness=%q want %q", rec.Objective, got, w)
		}
	}

	rec, _ := store.Get(closed.ID)
	blob, _ := json.Marshal(s.viewOf(rec))
	if strings.Contains(string(blob), `"liveness"`) {
		t.Fatalf("닫힌 Run 에 liveness 가 실렸다: %s", blob)
	}

	unknownTools(s)
	for _, id := range []string{alive.ID, gone.ID} {
		rec, _ := store.Get(id)
		if got := s.viewOf(rec).Liveness; got != "unknown" {
			t.Errorf("데몬이 답하지 못할 때 %s liveness=%q want unknown", rec.Objective, got)
		}
	}
}

// TC-ARD-4 (FR-ARD-2): dmctl status 는 모르는 생존을 liveUnknown 으로 말한다.
func TestToolStatusLiveUnknown(t *testing.T) {
	s, _, _ := statusServer(t)
	_, out := getStatus(t, s, "id=p1")
	if out["live"] != true {
		t.Fatalf("live=%v", out["live"])
	}
	if _, ok := out["liveUnknown"]; ok {
		t.Fatalf("아는 생존에 liveUnknown 이 실렸다: %v", out)
	}
	unknownTools(s)
	_, out = getStatus(t, s, "id=p1")
	if out["live"] != false || out["liveUnknown"] != true {
		t.Fatalf("모르는 생존: live=%v liveUnknown=%v", out["live"], out["liveUnknown"])
	}
}

// TC-ARD-4 (§3.4a): wait 는 생존을 모른다고 gone 으로 끝내지 않는다.
func TestToolStatusWaitDoesNotEndOnUnknown(t *testing.T) {
	s, _, _ := statusServer(t)
	unknownTools(s)
	_, out := getWait(t, s, "id=p1&for=done&timeoutMs=1500")
	if out["status"] != "timeout" {
		t.Fatalf("status=%v want timeout — 모르는 생존을 죽음으로 읽었다", out["status"])
	}
	if out["liveUnknown"] != true {
		t.Fatalf("마지막 관측에 liveUnknown 이 없다: %v", out)
	}
}
