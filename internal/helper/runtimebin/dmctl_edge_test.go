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

// PEER_NETWORK_SRS FR-PNW-73·74, EDGE_PAIRING_SRS FR-EPR-60 — dmctl edges · edge invite/add/remove.

const edgesFakeJSON = `{
 "node":{"enabled":true,"port":58147,"bind":"0.0.0.0","name":"office","tag":"4321","advertise":"",
  "fingerprint":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","listening":false,"error":"bind: address already in use"},
 "edges":[{"name":"home","tag":"1234","addr":"10.0.0.2","port":58147,"fp":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
          {"name":"home","tag":"5678","addr":"","port":0,"fp":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
          {"name":"laptop","addr":"10.0.0.4","port":58147,"fp":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}],
 "invite":null}`

// edgeReq 은 가짜 서버가 받은 요청 하나다.
type edgeReq struct {
	method, path string
	body         map[string]any
}

func withEdgeServer(t *testing.T, status int, resp string) (*[]edgeReq, func()) {
	t.Helper()
	calls := &[]edgeReq{}
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) {
		c := edgeReq{method: r.Method, path: r.URL.Path}
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

func TestDmctlEdgesText(t *testing.T) {
	calls, cleanup := withEdgeServer(t, 200, edgesFakeJSON)
	defer cleanup()
	rc, out, errOut := dmctlRun("edges")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut)
	}
	if c := (*calls)[0]; c.method != http.MethodGet || c.path != "/api/edges" {
		t.Fatalf("요청 %+v", c)
	}
	for _, want := range []string{
		// PROFILE_NAME_SRS FR-PFN-23: 이름은 핸들로 보인다. 번호가 없으면(구버전 서버) 이름만.
		"name=office#4321", "port=58147", "listening=no", "fp=0123456789abcdef", "address already in use",
		"edge     fp=aaaaaaaaaaaaaaaa  name=home#1234  addr=10.0.0.2:58147",
		"edge     fp=bbbbbbbbbbbbbbbb  name=home#5678  addr=-",
		"name=laptop  ",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("출력에 %q 가 없다:\n%s", want, out)
		}
	}
	if strings.Contains(out, "state=") || strings.Contains(out, "pending") {
		t.Errorf("승인 대기·상태가 보인다:\n%s", out)
	}
	// FR-PNW-95: 지문은 앞 16자만 보인다.
	if strings.Contains(out, strings.Repeat("a", 17)) {
		t.Errorf("지문 전체가 보인다:\n%s", out)
	}
}

func TestDmctlEdgesJSON(t *testing.T) {
	_, cleanup := withEdgeServer(t, 200, edgesFakeJSON)
	defer cleanup()
	rc, out, _ := dmctlRun("edges", "--json")
	var v map[string]any
	if rc != 0 || json.Unmarshal([]byte(out), &v) != nil || v["node"] == nil {
		t.Fatalf("rc=%d out=%q", rc, out)
	}
}

func TestDmctlEdgeInvite(t *testing.T) {
	calls, cleanup := withEdgeServer(t, 200, `{"code":"dmedge1:abc","expires":"2026-11-10T09:10:00Z"}`)
	defer cleanup()
	rc, out, errOut := dmctlRun("edge", "invite", "--addr", "192.168.0.5")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut)
	}
	c := (*calls)[0]
	if c.method != http.MethodPost || c.path != "/api/edges/invite" || c.body["addr"] != "192.168.0.5" {
		t.Fatalf("요청 %+v", c)
	}
	if strings.TrimSpace(out) != "dmedge1:abc" {
		t.Fatalf("stdout 은 코드 한 줄이어야 한다: %q", out)
	}
}

// FR-EPR-51: add 는 코드만 보내고, 맺은 상대의 이름과 지문 앞자리를 낸다.
func TestDmctlEdgeAdd(t *testing.T) {
	calls, cleanup := withEdgeServer(t, 200, `{"fp":"0123456789abcdef0011","name":"home"}`)
	defer cleanup()
	rc, out, errOut := dmctlRun("edge", "add", "dmedge1:abc")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut)
	}
	c := (*calls)[0]
	if c.path != "/api/edges/add" || c.body["code"] != "dmedge1:abc" || len(c.body) != 1 {
		t.Fatalf("요청 %+v", c)
	}
	if !strings.Contains(out, "home") || !strings.Contains(out, "0123456789abcdef") || strings.Contains(out, "0011") {
		t.Errorf("stdout %q", out)
	}
}

// FR-PNW-74: 닿지 않으면 사유 코드를 내고 1 로 끝난다.
func TestDmctlEdgeAddUnreachable(t *testing.T) {
	_, cleanup := withEdgeServer(t, 502, `{"code":"edge_unreachable","message":"dial tcp: refused"}`)
	defer cleanup()
	rc, _, errOut := dmctlRun("edge", "add", "dmedge1:abc")
	if rc != 1 || !strings.Contains(errOut, "edge_unreachable") {
		t.Fatalf("rc=%d stderr=%q", rc, errOut)
	}
}

// FR-EPR-52·60: remove 는 지문 앞자리를 보내고, 상대에게 알리지 못했으면 stderr 에 알린다.
func TestDmctlEdgeRemove(t *testing.T) {
	calls, cleanup := withEdgeServer(t, 200, `{"fp":"0123456789abcdef0011","name":"home","notified":false}`)
	defer cleanup()
	rc, out, e := dmctlRun("edge", "remove", "01234567")
	if rc != 0 {
		t.Fatalf("remove rc=%d %s", rc, e)
	}
	if (*calls)[0].path != "/api/edges/remove" || (*calls)[0].body["fp"] != "01234567" {
		t.Fatalf("remove 요청 %+v", (*calls)[0])
	}
	if !strings.Contains(out, "home") || !strings.Contains(e, "알리지 못했습니다") {
		t.Fatalf("out=%q err=%q", out, e)
	}
}

// FR-EPR-60: approve·reject·--name 은 없다. 서버에 보내지 않는다.
func TestDmctlEdgePendingCommandsGone(t *testing.T) {
	var hits atomic.Int64
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) { hits.Add(1) })
	defer cleanup()
	for _, args := range [][]string{{"edge", "approve", "p1"}, {"edge", "reject", "p1"}, {"edge", "add", "c", "--name", "x"}} {
		if rc, _, _ := dmctlRun(args...); rc != 2 {
			t.Errorf("%v: rc=%d, 기대 2", args, rc)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("서버에 %d 번 보냈다", hits.Load())
	}
}

// 인자가 틀리면 서버에 아무것도 보내지 않고 2 로 끝난다.
func TestDmctlEdgeUsage(t *testing.T) {
	var hits atomic.Int64
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) { hits.Add(1) })
	defer cleanup()
	for _, args := range [][]string{
		{"edge"}, {"edge", "bogus"}, {"edge", "add"},
		{"edge", "remove"}, {"edge", "invite", "--addr"}, {"edge", "add", "c", "--nope"},
	} {
		if rc, _, _ := dmctlRun(args...); rc != 2 {
			t.Errorf("%v: rc=%d, 기대 2", args, rc)
		}
	}
	for _, args := range [][]string{{"edge", "--help"}, {"edge", "add", "--help"}, {"edges", "--help"}} {
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
	calls, cleanup := withEdgeServer(t, 200, `{"toolId":"u-1","from":"me","to":"u-1","len":2}`)
	defer cleanup()
	if rc, _, e := dmctlRun("msg", "--to", "u-1", "hi"); rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	if (*calls)[0].path != "/api/tools/message" {
		t.Fatalf("요청 %+v", (*calls)[0])
	}
}

// 상대가 보낸 주소·이름도 찍기 전에 제어 문자를 지운다.
func TestDmctlEdgesCleansRemoteText(t *testing.T) {
	body := strings.Replace(edgesFakeJSON, `"name":"laptop","addr":"10.0.0.4"`, `"name":"lap\u001b[2Jtop","addr":"10.0.0.4\u001b]0;x\u0007"`, 1)
	_, cleanup := withEdgeServer(t, 200, body)
	defer cleanup()
	if _, out, _ := dmctlRun("edges"); strings.ContainsAny(out, "\x1b\x07") {
		t.Fatalf("제어 문자가 찍혔다 %q", out)
	}
}

// 로컬 API 의 거절 본문과 상대가 준 이름도 제어 문자를 지우고 찍는다.
func TestDmctlEdgeCleansRefusalAndReason(t *testing.T) {
	refusals := []string{
		`{"code":"edge_unreachable","message":"x\u001b]52;c;AA==\u0007"}`,
		"\x1b]0;title\x07 not json",
	}
	for _, body := range refusals {
		_, cleanup := withEdgeServer(t, 502, body)
		if _, _, e := dmctlRun("edge", "remove", "01234567"); strings.ContainsAny(e, "\x1b\x07") {
			t.Errorf("거절 출력에 제어 문자 %q", e)
		}
		cleanup()
	}
	_, cleanup := withEdgeServer(t, 200, `{"name":"la\u001b[2Jp","fp":"f\u001b]52;c;AA==\u0007"}`)
	defer cleanup()
	if _, out, e := dmctlRun("edge", "add", "dmedge1:abc"); strings.ContainsAny(out+e, "\x1b\x07") {
		t.Errorf("add 출력에 제어 문자 %q %q", out, e)
	}
}

// L-14: --name=x 형식, -- 종료자, 값 자리에 온 플래그.
func TestParseSubArgsForms(t *testing.T) {
	pa, err := parseSubArgs([]string{"--name=lap", "code", "--", "--json"}, []string{"name"}, []string{"json"})
	if err != nil || pa.flags["name"] != "lap" || len(pa.pos) != 2 || pa.pos[1] != "--json" || pa.bools["json"] {
		t.Fatalf("%+v %v", pa, err)
	}
	if _, err := parseSubArgs([]string{"--name", "--json"}, []string{"name"}, []string{"json"}); err == nil {
		t.Fatal("--name 의 값으로 --json 을 먹었다")
	}
	if _, err := parseSubArgs([]string{"--json=1"}, nil, []string{"json"}); err == nil {
		t.Fatal("불 플래그에 값을 받았다")
	}
}

// PEER_DAEMON_SRS FR-PDM-62 (TC-PDM-21): 원격 명령 하위 명령은 없다. 서버에 보내지 않는다.
func TestDmctlEdgeRemovedSubs(t *testing.T) {
	var hits atomic.Int64
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) { hits.Add(1) })
	defer cleanup()
	for _, args := range [][]string{
		{"edge", "info", "home"}, {"edge", "tools", "home"}, {"edge", "spawn", "home", "hi", "--agent", "claude", "--cwd", "/w"},
		{"edge", "status", "home/u-1"}, {"edge", "close", "home/u-1"},
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
	calls, cleanup := withEdgeServer(t, 404, `{"error":"no such tool"}`)
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

// FR-PDM-66·67: 세션 안내문에 원격 엔벨로프가 없고, dmctl edges 는 lastSeen 을 보이지 않는다.
func TestDmctlNoEdgeRemnants(t *testing.T) {
	if strings.Contains(agentContextText, "DONGMINAL-PEER-MSG") {
		t.Error("안내문에 원격 엔벨로프가 남았다")
	}
	body := strings.Replace(edgesFakeJSON, `"port":58147,"fp":"aaaa`, `"lastSeen":"2026-11-10T09:01:02Z","port":58147,"fp":"aaaa`, 1)
	_, cleanup := withEdgeServer(t, 200, body)
	defer cleanup()
	if _, out, _ := dmctlRun("edges"); strings.Contains(out, "lastSeen") {
		t.Fatalf("lastSeen 을 보였다 %q", out)
	}
}

// PEER_DAEMON_SRS FR-PDM-70 (TC-PDM-25): 옛 명령 이름은 없다. 서버에 보내지 않는다.
func TestDmctlOldPeerCommandsGone(t *testing.T) {
	var hits atomic.Int64
	cleanup := withDmctlServer(t, func(w http.ResponseWriter, r *http.Request) { hits.Add(1) })
	defer cleanup()
	for _, args := range [][]string{{"peers"}, {"peer", "invite"}, {"peer", "remove", "home"}} {
		if rc, _, _ := dmctlRun(args...); rc == 0 {
			t.Errorf("%v: rc=0, 기대 실패", args)
		}
	}
	if hits.Load() != 0 {
		t.Fatalf("서버에 %d 번 보냈다", hits.Load())
	}
}

// EDGE_MESH_SRS FR-EGM-62: dmctl edge notify 는 /api/edges/notify 를 부르고 알린 상대를 찍는다.
func TestDmctlEdgeNotify(t *testing.T) {
	calls, cleanup := withEdgeServer(t, 200, `{"fp":"aaaaaaaaaaaaaaaaaaaaaaaa","name":"home","tag":"1234","notified":true}`)
	defer cleanup()
	rc, out, errOut := dmctlRun("edge", "notify", "home#1234")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut)
	}
	if c := (*calls)[0]; c.method != http.MethodPost || c.path != "/api/edges/notify" || c.body["fp"] != "home#1234" {
		t.Fatalf("요청 %+v", c)
	}
	if out != "알렸습니다: home#1234\n" {
		t.Fatalf("stdout %q", out)
	}
}

// FR-EGM-62: 실패하면 사유 코드를 찍고 1 이다. 인자가 없으면 2 다.
func TestDmctlEdgeNotifyFails(t *testing.T) {
	_, cleanup := withEdgeServer(t, 409, `{"code":"edge_addr_unknown","message":"상대 주소를 모른다"}`)
	defer cleanup()
	rc, _, errOut := dmctlRun("edge", "notify", "home#1234")
	if rc != 1 || !strings.Contains(errOut, "edge_addr_unknown") {
		t.Fatalf("rc=%d stderr=%s", rc, errOut)
	}
	if rc, _, _ := dmctlRun("edge", "notify"); rc != 2 {
		t.Fatalf("인자 없음 rc=%d", rc)
	}
}

// FR-EGM-63: 간선 줄 끝에 알림 대기·옛 판을 적는다.
func TestDmctlEdgesShowsMeshMarks(t *testing.T) {
	_, cleanup := withEdgeServer(t, 200, `{"node":{"name":"office","tag":"4321"},
 "edges":[{"name":"home","tag":"1234","addr":"10.0.0.2","port":1,"fp":"aaaaaaaaaaaaaaaaaaaaaaaa","pending":true},
          {"name":"old","tag":"5678","addr":"10.0.0.3","port":1,"fp":"bbbbbbbbbbbbbbbbbbbbbbbb","outdated":true},
          {"name":"ok","tag":"9999","addr":"10.0.0.4","port":1,"fp":"cccccccccccccccccccccccc"}]}`)
	defer cleanup()
	_, out, _ := dmctlRun("edges")
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 4 {
		t.Fatalf("줄 %q", out)
	}
	if !strings.HasSuffix(lines[1], "  알림 대기") || !strings.HasSuffix(lines[2], "  옛 판") || strings.Contains(lines[3], "대기") || strings.Contains(lines[3], "옛 판") {
		t.Fatalf("표시 %q", out)
	}
}
