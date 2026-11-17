package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

// PEER_NETWORK_SRS FR-PNW-73·74 — dmctl peers · peer invite/add/approve/reject/remove.

const peersFakeJSON = `{
 "node":{"enabled":true,"port":58147,"bind":"0.0.0.0","name":"office","advertise":"",
  "fingerprint":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","listening":false,"error":"bind: address already in use"},
 "peers":[{"name":"home","addr":"10.0.0.2","port":58147,"fp":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":""},
          {"name":"lab","addr":"10.0.0.3","port":58147,"fp":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","state":"pending-out","expires":"2026-11-10T09:10:00Z"}],
 "pending":[{"id":"p1","name":"laptop","addr":"10.0.0.4","port":58147,"fp":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","expires":"2026-11-10T09:10:00Z"}],
 "invite":null}`

// peerReq 은 가짜 서버가 받은 요청 하나다.
type peerReq struct {
	method, path string
	body         map[string]any
}

func withPeerServer(t *testing.T, status int, resp string) (*[]peerReq, func()) {
	t.Helper()
	calls := &[]peerReq{}
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		c := peerReq{method: r.Method, path: r.URL.Path}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &c.body)
		*calls = append(*calls, c)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		io.WriteString(w, resp)
	})
	return calls, cleanup
}

func dmctlRun(args ...string) (int, string, string) {
	var so, se bytes.Buffer
	rc := runDmctl(args, &so, &se)
	return rc, so.String(), se.String()
}

func TestDmctlPeersText(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, peersFakeJSON)
	defer cleanup()
	rc, out, errOut := dmctlRun("peers")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut)
	}
	if c := (*calls)[0]; c.method != http.MethodGet || c.path != "/api/peers" {
		t.Fatalf("요청 %+v", c)
	}
	for _, want := range []string{
		"name=office", "port=58147", "listening=no", "fp=0123456789abcdef", "address already in use",
		"name=home", "addr=10.0.0.2:58147", "state=paired",
		"name=lab", "state=pending-out",
		"id=p1", "name=laptop",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("출력에 %q 가 없다:\n%s", want, out)
		}
	}
	// FR-PNW-95: 지문은 앞 16자만 보인다.
	if strings.Contains(out, strings.Repeat("a", 17)) {
		t.Errorf("지문 전체가 보인다:\n%s", out)
	}
}

func TestDmctlPeersJSON(t *testing.T) {
	_, cleanup := withPeerServer(t, 200, peersFakeJSON)
	defer cleanup()
	rc, out, _ := dmctlRun("peers", "--json")
	var v map[string]any
	if rc != 0 || json.Unmarshal([]byte(out), &v) != nil || v["node"] == nil {
		t.Fatalf("rc=%d out=%q", rc, out)
	}
}

func TestDmctlPeerInvite(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, `{"code":"dmpeer1:abc","expires":"2026-11-10T09:10:00Z"}`)
	defer cleanup()
	rc, out, errOut := dmctlRun("peer", "invite", "--addr", "192.168.0.5")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut)
	}
	c := (*calls)[0]
	if c.method != http.MethodPost || c.path != "/api/peers/invite" || c.body["addr"] != "192.168.0.5" {
		t.Fatalf("요청 %+v", c)
	}
	if strings.TrimSpace(out) != "dmpeer1:abc" {
		t.Fatalf("stdout 은 코드 한 줄이어야 한다: %q", out)
	}
}

func TestDmctlPeerAdd(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, `{"name":"home","state":"pending-out","warning":"port_closed"}`)
	defer cleanup()
	rc, out, errOut := dmctlRun("peer", "add", "dmpeer1:abc", "--name", "home")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut)
	}
	c := (*calls)[0]
	if c.path != "/api/peers/add" || c.body["code"] != "dmpeer1:abc" || c.body["name"] != "home" {
		t.Fatalf("요청 %+v", c)
	}
	if !strings.Contains(out, "home") {
		t.Errorf("stdout %q", out)
	}
	// FR-PNW-33: 내 포트가 닫혀 있으면 미리 알린다.
	if !strings.Contains(errOut, "노드 포트") {
		t.Errorf("포트 경고가 없다: %q", errOut)
	}
}

// FR-PNW-74: 닿지 않으면 사유 코드를 내고 1 로 끝난다.
func TestDmctlPeerAddUnreachable(t *testing.T) {
	_, cleanup := withPeerServer(t, 502, `{"code":"peer_unreachable","message":"dial tcp: refused"}`)
	defer cleanup()
	rc, _, errOut := dmctlRun("peer", "add", "dmpeer1:abc")
	if rc != 1 || !strings.Contains(errOut, "peer_unreachable") {
		t.Fatalf("rc=%d stderr=%q", rc, errOut)
	}
}

func TestDmctlPeerApprove(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, `{"name":"lap","confirmed":false,"reason":"상대 노드에 닿지 못했습니다"}`)
	defer cleanup()
	rc, out, errOut := dmctlRun("peer", "approve", "p1", "--name", "lap")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut)
	}
	c := (*calls)[0]
	if c.path != "/api/peers/approve" || c.body["id"] != "p1" || c.body["name"] != "lap" {
		t.Fatalf("요청 %+v", c)
	}
	if !strings.Contains(out, "lap") || !strings.Contains(errOut, "닿지 못했습니다") {
		t.Fatalf("out=%q err=%q", out, errOut)
	}
}

func TestDmctlPeerRejectAndRemove(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, `{}`)
	defer cleanup()
	if rc, _, e := dmctlRun("peer", "reject", "p1"); rc != 0 {
		t.Fatalf("reject rc=%d %s", rc, e)
	}
	if rc, _, e := dmctlRun("peer", "remove", "home"); rc != 0 {
		t.Fatalf("remove rc=%d %s", rc, e)
	}
	if (*calls)[0].path != "/api/peers/reject" || (*calls)[0].body["id"] != "p1" {
		t.Fatalf("reject 요청 %+v", (*calls)[0])
	}
	if (*calls)[1].path != "/api/peers/remove" || (*calls)[1].body["name"] != "home" {
		t.Fatalf("remove 요청 %+v", (*calls)[1])
	}
}

// 인자가 틀리면 서버에 아무것도 보내지 않고 2 로 끝난다.
func TestDmctlPeerUsage(t *testing.T) {
	var hits atomic.Int64
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) { hits.Add(1) })
	defer cleanup()
	for _, args := range [][]string{
		{"peer"}, {"peer", "bogus"}, {"peer", "add"}, {"peer", "approve"}, {"peer", "reject"},
		{"peer", "remove"}, {"peer", "invite", "--addr"}, {"peer", "add", "c", "--nope"},
	} {
		if rc, _, _ := dmctlRun(args...); rc != 2 {
			t.Errorf("%v: rc=%d, 기대 2", args, rc)
		}
	}
	for _, args := range [][]string{{"peer", "--help"}, {"peer", "add", "--help"}, {"peers", "--help"}} {
		if rc, out, _ := dmctlRun(args...); rc != 0 || out == "" {
			t.Errorf("%v: rc=%d out=%q", args, rc, out)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("서버에 %d 번 보냈다", hits.Load())
	}
}

// `/` 가 없으면 지금처럼 로컬 전달이다.
func TestDmctlMsgLocalUnchanged(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, `{"toolId":"u-1","from":"me","to":"u-1","len":2}`)
	defer cleanup()
	if rc, _, e := dmctlRun("msg", "--to", "u-1", "hi"); rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	if (*calls)[0].path != "/api/tools/message" {
		t.Fatalf("요청 %+v", (*calls)[0])
	}
}

// 상대가 보낸 주소·이름도 찍기 전에 제어 문자를 지운다.
func TestDmctlPeersCleansRemoteText(t *testing.T) {
	body := strings.Replace(peersFakeJSON, `"name":"laptop","addr":"10.0.0.4"`, `"name":"lap\u001b[2Jtop","addr":"10.0.0.4\u001b]0;x\u0007"`, 1)
	_, cleanup := withPeerServer(t, 200, body)
	defer cleanup()
	if _, out, _ := dmctlRun("peers"); strings.ContainsAny(out, "\x1b\x07") {
		t.Fatalf("제어 문자가 찍혔다 %q", out)
	}
}

// 로컬 API 의 거절 본문과 상대가 준 사유도 제어 문자를 지우고 찍는다.
func TestDmctlPeerCleansRefusalAndReason(t *testing.T) {
	refusals := []string{
		`{"code":"peer_unreachable","message":"x\u001b]52;c;AA==\u0007"}`,
		"\x1b]0;title\x07 not json",
	}
	for _, body := range refusals {
		_, cleanup := withPeerServer(t, 502, body)
		if _, _, e := dmctlRun("peer", "reject", "p1"); strings.ContainsAny(e, "\x1b\x07") {
			t.Errorf("거절 출력에 제어 문자 %q", e)
		}
		cleanup()
	}
	_, cleanup := withPeerServer(t, 200, `{"name":"la\u001b[2Jp","confirmed":false,"reason":"r\u001b]52;c;AA==\u0007"}`)
	defer cleanup()
	if _, out, e := dmctlRun("peer", "approve", "p1"); strings.ContainsAny(out+e, "\x1b\x07") {
		t.Errorf("approve 출력에 제어 문자 %q %q", out, e)
	}
}

// L-14: --name=x 형식, -- 종료자, 값 자리에 온 플래그.
func TestParsePeerArgsForms(t *testing.T) {
	pa, err := parsePeerArgs([]string{"--name=lap", "code", "--", "--json"}, []string{"name"}, []string{"json"})
	if err != nil || pa.flags["name"] != "lap" || len(pa.pos) != 2 || pa.pos[1] != "--json" || pa.bools["json"] {
		t.Fatalf("%+v %v", pa, err)
	}
	if _, err := parsePeerArgs([]string{"--name", "--json"}, []string{"name"}, []string{"json"}); err == nil {
		t.Fatal("--name 의 값으로 --json 을 먹었다")
	}
	if _, err := parsePeerArgs([]string{"--json=1"}, nil, []string{"json"}); err == nil {
		t.Fatal("불 플래그에 값을 받았다")
	}
}

// L-10: approve 는 승인한 지문(앞 16자)을 낸다 — 상대 화면의 지문과 대조하라고.
func TestDmctlPeerApprovePrintsFingerprint(t *testing.T) {
	_, cleanup := withPeerServer(t, 200, `{"name":"lap","fp":"0123456789abcdef0011","confirmed":true}`)
	defer cleanup()
	rc, out, e := dmctlRun("peer", "approve", "p1")
	if rc != 0 || !strings.Contains(out, "0123456789abcdef") || strings.Contains(out, "0011") {
		t.Fatalf("rc=%d out=%q err=%q", rc, out, e)
	}
}

// PEER_DAEMON_SRS FR-PDM-62 (TC-PDM-21): 원격 명령 하위 명령은 없다. 서버에 보내지 않는다.
func TestDmctlPeerRemovedSubs(t *testing.T) {
	var hits atomic.Int64
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) { hits.Add(1) })
	defer cleanup()
	for _, args := range [][]string{
		{"peer", "info", "home"}, {"peer", "tools", "home"}, {"peer", "spawn", "home", "hi", "--agent", "claude", "--cwd", "/w"},
		{"peer", "status", "home/u-1"}, {"peer", "close", "home/u-1"},
	} {
		if rc, _, _ := dmctlRun(args...); rc != 2 {
			t.Errorf("%v: rc=%d, 기대 2", args, rc)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("서버에 %d 번 보냈다", hits.Load())
	}
}

// FR-PDM-62: `/` 가 든 --to 도 로컬 경로로 간다. 원격 호출은 없다.
func TestDmctlMsgSlashIsNotRemote(t *testing.T) {
	calls, cleanup := withPeerServer(t, 404, `{"error":"no such tool"}`)
	defer cleanup()
	if rc, _, _ := dmctlRun("msg", "--to", "home/u-1", "hi"); rc == 0 {
		t.Fatal("성공하면 안 된다")
	}
	for _, c := range *calls {
		if c.path != "/api/tools/message" {
			t.Fatalf("요청 %+v", c)
		}
	}
}

// FR-PDM-66·67: 세션 안내문에 원격 엔벨로프가 없고, dmctl peers 는 lastSeen 을 보이지 않는다.
func TestDmctlNoPeerRemnants(t *testing.T) {
	if strings.Contains(agentContextText, "DONGMINAL-PEER-MSG") {
		t.Error("안내문에 원격 엔벨로프가 남았다")
	}
	body := strings.Replace(peersFakeJSON, `"state":""}`, `"state":"","lastSeen":"2026-11-10T09:01:02Z"}`, 1)
	_, cleanup := withPeerServer(t, 200, body)
	defer cleanup()
	if _, out, _ := dmctlRun("peers"); strings.Contains(out, "lastSeen") {
		t.Fatalf("lastSeen 을 보였다 %q", out)
	}
}
