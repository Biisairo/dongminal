package runtimebin

import (
	"bytes"
	"io"
	"net/http"
	"strings"
	"testing"
)

// 묶음 P — 동료 명부의 CLI 절반 (ORCHESTRATION_V2_SRS FR-PAT-5).

// FR-PAT-5: 인자가 없다. 소속은 호출자의 정체($DONGMINAL_TOOL_ID)로 정해진다.
func TestDmctlRun_PeersSendsCallerIdentityAndTakesNoArgs(t *testing.T) {
	ts, calls := runStub(t, map[string]string{
		"/api/runs/peers": `{"runId":"run-1","memberId":"m-a","role":"작가","peers":[
		  {"role":"비평가","memberId":"m-b","to":"tool-b","state":"working","headless":false},
		  {"role":"검수","memberId":"m-c","to":"tool-c","state":"ready","headless":true}]}`,
	})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"peers"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d (%s)", code, out.String())
	}
	if len(*calls) != 1 || (*calls)[0].Method != http.MethodGet || (*calls)[0].Path != "/api/runs/peers" {
		t.Fatalf("요청이 다르다: %+v", *calls)
	}
	if !strings.Contains((*calls)[0].Query, "toolId=tool-a") {
		t.Fatalf("호출자 정체를 싣지 않았다: %q", (*calls)[0].Query)
	}
	// 한 줄에 네 가지가 다 있어야 한다 — 왕복을 더 만들지 않는 것이 요점이다.
	line := strings.Split(strings.TrimSpace(out.String()), "\n")[0]
	for _, want := range []string{"role=비평가", "member=m-b", "to=tool-b", "state=working", "headless=false"} {
		if !strings.Contains(line, want) {
			t.Fatalf("%q 가 없다: %q", want, line)
		}
	}
	if !strings.Contains(out.String(), "headless=true") {
		t.Fatalf("헤드리스 동료가 그렇게 표시되지 않았다: %q", out.String())
	}
}

// 동료가 없는 것은 오류가 아니다 — 첫 멤버는 실제로 혼자다.
func TestDmctlRun_PeersEmptyRosterIsNotAnError(t *testing.T) {
	ts, _ := runStub(t, map[string]string{"/api/runs/peers": `{"runId":"run-1","peers":[]}`})
	pointDmctlAtServer(t, ts, "tool-a")

	var out bytes.Buffer
	if code := runDmctlRun([]string{"peers"}, &out, io.Discard); code != 0 {
		t.Fatalf("exit = %d", code)
	}
	if !strings.Contains(out.String(), "동료 없음") {
		t.Fatalf("빈 명부 안내가 없다: %q", out.String())
	}
}

// V-PAT-7: Run 에 속하지 않은 도구의 호출은 거부되고, 사유가 그대로 드러난다.
func TestDmctlRun_PeersSurfacesTheRefusalReason(t *testing.T) {
	ts, _ := runStub(t,
		map[string]string{"/api/runs/peers": `{"error":"sender_not_member","detail":"Run 의 멤버가 아니다"}`},
		http.StatusForbidden)
	pointDmctlAtServer(t, ts, "tool-z")

	var errOut bytes.Buffer
	if code := runDmctlRun([]string{"peers"}, io.Discard, &errOut); code == 0 {
		t.Fatal("멤버가 아닌 도구의 호출이 성공했다")
	}
	if !strings.Contains(errOut.String(), "sender_not_member") {
		t.Fatalf("거부 사유가 묻혔다: %q", errOut.String())
	}
}
