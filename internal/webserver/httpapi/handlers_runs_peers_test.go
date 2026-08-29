package httpapi

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"dongminal/internal/webserver/domain/run"

	"dongminal/internal/shared/testpath"
)

// 묶음 P — 동료 명부 (ORCHESTRATION_V2_SRS FR-PAT-5, V-PAT-6~8).

// peersOf calls the endpoint and returns the decoded roster.
func peersOf(t *testing.T, s *Server) (int, []map[string]any) {
	t.Helper()
	code, out := getRun(t, s, "/api/runs/peers")
	raw, _ := json.Marshal(out["peers"])
	var peers []map[string]any
	_ = json.Unmarshal(raw, &peers)
	return code, peers
}

// FR-PAT-5: 명부는 **자기를 제외한** 같은 Run 의 동료를 낸다.
func TestApiRunPeers_ExcludesTheCallerAndKeepsTheRest(t *testing.T) {
	s, _, _, _ := runsServer(t, "tool-a")
	runID := startRun(t, s)
	for _, spec := range []string{
		`{"runId":` + testpath.JSONQuote(runID) + `,"role":"작가","agent":"claude","id":"tool-a"}`,
		`{"runId":` + testpath.JSONQuote(runID) + `,"role":"비평가","agent":"claude","id":"tool-b"}`,
	} {
		if code, out := postRun(t, s, "/api/runs/members", spec); code != http.StatusOK {
			t.Fatalf("멤버 등록 실패 %d (%+v)", code, out)
		}
	}
	code, peers := peersOf(t, s)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	if len(peers) != 1 {
		t.Fatalf("자기를 뺀 1명이어야 한다: %+v", peers)
	}
	p := peers[0]
	if p["role"] != "비평가" || p["to"] != "tool-b" {
		t.Fatalf("동료 행이 어긋난다: %+v", p)
	}
	// member uuid 와 to 가 **둘 다** 있어야 한다 — 전자는 기록에서의 정체이고,
	// 후자는 dmctl msg 가 실제로 라우팅하는 값이다.
	if id, _ := p["memberId"].(string); id == "" {
		t.Fatalf("member uuid 가 없다: %+v", p)
	}
	if p["state"] == nil || p["headless"] == nil {
		t.Fatalf("state·headless 가 빠졌다 (FR-PAT-5): %+v", p)
	}
}

// V-PAT-7: Run 에 속하지 않은 도구의 호출은 거부된다. 조정자도 멤버가 아니므로
// 여기서 거부된다 — 조정자의 명부는 `run status` 다.
func TestApiRunPeers_RejectsNonMembers(t *testing.T) {
	s, _, _, who := runsServer(t, "tool-a")
	runID := startRun(t, s)
	if code, out := postRun(t, s, "/api/runs/members",
		`{"runId":`+testpath.JSONQuote(runID)+`,"role":"작가","agent":"claude","id":"tool-b"}`); code != http.StatusOK {
		t.Fatalf("멤버 등록 실패 %d (%+v)", code, out)
	}

	// 조정자(tool-a)는 멤버가 아니다.
	if code, _ := getRun(t, s, "/api/runs/peers"); code != http.StatusForbidden {
		t.Fatalf("조정자 호출 want 403, got %d", code)
	}
	// 아무 관계 없는 도구.
	who.toolID = "tool-z"
	code, out := getRun(t, s, "/api/runs/peers")
	if code != http.StatusForbidden {
		t.Fatalf("외부 도구 호출 want 403, got %d", code)
	}
	if out["error"] != "sender_not_member" {
		t.Fatalf("거부 사유를 뭉뚱그렸다: %+v", out)
	}
	// 멤버가 부르면 열린다.
	who.toolID = "tool-b"
	if code, _ := getRun(t, s, "/api/runs/peers"); code != http.StatusOK {
		t.Fatalf("멤버 호출 want 200, got %d", code)
	}
}

// V-PAT-8: 승계·이탈로 자리를 넘긴 멤버는 명부에서 사라진다. 남겨 두면 아무도
// 읽지 않는 주소로 메시지가 가고, 발신자는 상한까지 기다림을 태운다.
func TestApiRunPeers_DropsSucceededAndReleasedMembers(t *testing.T) {
	s, _, _, who := runsServer(t, "tool-a")
	who.toolID = "tool-a"
	s.Runs = storeWithFixture(t, `{
	  "schemaVersion": 1,
	  "runs": [{
	    "id": "run-1", "short": "run-1", "objective": "합평",
	    "projection": "dedicated-window", "isolation": "none",
	    "state": "open", "epoch": "epoch-test", "coordinatorToolId": "tool-x",
	    "members": [
	      {"id":"m-a","runId":"run-1","role":"작가","agent":"claude","toolId":"tool-a","state":"working","createdAt":1},
	      {"id":"m-b","runId":"run-1","role":"비평가","agent":"claude","toolId":"tool-b","state":"working","createdAt":1},
	      {"id":"m-c","runId":"run-1","role":"선임 작가","agent":"claude","toolId":"tool-c","state":"succeeded","createdAt":1},
	      {"id":"m-d","runId":"run-1","role":"검수","agent":"claude","toolId":"tool-d","state":"released","createdAt":1}
	    ]
	  }]
	}`)

	code, peers := peersOf(t, s)
	if code != http.StatusOK {
		t.Fatalf("want 200, got %d", code)
	}
	if len(peers) != 1 || peers[0]["memberId"] != "m-b" {
		t.Fatalf("승계·이탈한 멤버가 명부에 남았다: %+v", peers)
	}
}

// 도구가 죽은 동료는 **명부에 남는다** — state=lost 가 곧 조정자에게 알리라는
// 신호이며(FR-PAT-6), 지워 버리면 발신자는 상대가 없어진 사실조차 모른다.
func TestApiRunPeers_KeepsLostPeersSoTheCallerCanReport(t *testing.T) {
	s, _, _, who := runsServer(t, "tool-a")
	who.toolID = "tool-a"
	s.Runs = storeWithFixture(t, `{
	  "schemaVersion": 1,
	  "runs": [{
	    "id": "run-1", "short": "run-1", "objective": "합평",
	    "projection": "dedicated-window", "isolation": "none",
	    "state": "open", "epoch": "epoch-test", "coordinatorToolId": "tool-x",
	    "members": [
	      {"id":"m-a","runId":"run-1","role":"작가","agent":"claude","toolId":"tool-a","state":"working","createdAt":1},
	      {"id":"m-z","runId":"run-1","role":"비평가","agent":"claude","toolId":"tool-gone","state":"working","headless":true,"createdAt":1}
	    ]
	  }]
	}`)

	_, peers := peersOf(t, s)
	if len(peers) != 1 {
		t.Fatalf("죽은 동료가 명부에서 사라졌다: %+v", peers)
	}
	if peers[0]["state"] != string(run.Lost) {
		t.Fatalf("state 가 lost 여야 한다: %+v", peers[0])
	}
	if peers[0]["headless"] != true {
		t.Fatalf("headless 가 그대로 실려야 한다: %+v", peers[0])
	}
}

// 다른 Run 의 멤버는 동료가 아니다.
func TestApiRunPeers_DoesNotCrossRunBoundaries(t *testing.T) {
	s, _, _, who := runsServer(t, "tool-a")
	who.toolID = "tool-a"
	s.Runs = storeWithFixture(t, `{
	  "schemaVersion": 1,
	  "runs": [
	    {"id":"run-1","short":"run-1","objective":"A","projection":"inline","isolation":"none",
	     "state":"open","epoch":"epoch-test",
	     "members":[{"id":"m-a","runId":"run-1","role":"작가","agent":"claude","toolId":"tool-a","state":"working","createdAt":1}]},
	    {"id":"run-2","short":"run-2","objective":"B","projection":"inline","isolation":"none",
	     "state":"open","epoch":"epoch-test",
	     "members":[{"id":"m-b","runId":"run-2","role":"비평가","agent":"claude","toolId":"tool-b","state":"working","createdAt":1}]}
	  ]
	}`)

	_, peers := peersOf(t, s)
	if len(peers) != 0 {
		t.Fatalf("남의 Run 멤버가 명부에 섞였다: %+v", peers)
	}
}

// storeWithFixture builds a store over a handcrafted runs.json. 상태를 직접
// 지정할 수 있는 유일한 경로다 — 저장소에는 released·succeeded 로 옮기는 공개
// API 가 없고, 그 둘이 명부에서 빠지는 것이 V-PAT-8 이다.
func storeWithFixture(t *testing.T, body string) *run.Store {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "runs.json"), []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
	st := run.NewStore(dir, "epoch-test")
	if err := st.Load(); err != nil {
		t.Fatal(err)
	}
	return st
}
