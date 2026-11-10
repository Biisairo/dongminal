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
 "node":{"enabled":true,"port":58147,"bind":"0.0.0.0","name":"office","advertise":"","allowedDirs":[],
  "fingerprint":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","listening":false,"error":"bind: address already in use"},
 "peers":[{"name":"home","addr":"10.0.0.2","port":58147,"fp":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","state":""},
          {"name":"lab","addr":"10.0.0.3","port":58147,"fp":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","state":"pending-out","expires":"2026-11-10T09:10:00Z"}],
 "pending":[{"id":"p1","name":"laptop","addr":"10.0.0.4","port":58147,"fp":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","expires":"2026-11-10T09:10:00Z"}],
 "invite":null}`

// peerCall 은 가짜 서버가 받은 요청 하나다.
type peerCall struct {
	method, path string
	body         map[string]any
}

func withPeerServer(t *testing.T, status int, resp string) (*[]peerCall, func()) {
	t.Helper()
	calls := &[]peerCall{}
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		c := peerCall{method: r.Method, path: r.URL.Path}
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
