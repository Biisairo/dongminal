package runtimebin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// PEER_NETWORK_SRS FR-PNW-73·74 — dmctl peers · peer invite/add/approve/reject/remove.

const peersFakeJSON = `{
 "node":{"enabled":true,"port":58147,"bind":"0.0.0.0","name":"office","advertise":"","allowedDirs":[],
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

// FR-PNW-73: --to 에 `/` 가 있으면 원격 message.send 다. 보낸 도구는 지금 도구다 (FR-PNW-72).
func TestDmctlMsgRemote(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, `{"toolId":"u-1","len":2}`)
	defer cleanup()
	t.Setenv("DONGMINAL_TOOL_ID", "me-1")
	rc, out, errOut := dmctlRun("msg", "--to", "home/u-1", "hi")
	if rc != 0 {
		t.Fatalf("rc=%d stderr=%s", rc, errOut)
	}
	c := (*calls)[0]
	args, _ := c.body["args"].(map[string]any)
	if c.path != "/api/peers/call" || c.body["peer"] != "home" || c.body["op"] != "message.send" ||
		c.body["from"] != "me-1" || args["to"] != "u-1" || args["message"] != "hi" {
		t.Fatalf("요청 %+v", c)
	}
	if !strings.Contains(out, "home/u-1") {
		t.Fatalf("stdout %q", out)
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

// FR-PNW-74: 원격 전달이 닿지 않으면 사유 코드와 1.
func TestDmctlMsgRemoteUnreachable(t *testing.T) {
	_, cleanup := withPeerServer(t, 502, `{"code":"peer_unreachable","message":"x"}`)
	defer cleanup()
	if rc, _, e := dmctlRun("msg", "--to", "home/u-1", "hi"); rc != 1 || !strings.Contains(e, "peer_unreachable") {
		t.Fatalf("rc=%d %q", rc, e)
	}
}

func TestDmctlPeerInfo(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, `{"name":"home","version":"1.2.4","proto":1,"commands":["agents.list","message.send","node.info"],"agents":["claude"],"allowedDirs":["/work"]}`)
	defer cleanup()
	rc, out, e := dmctlRun("peer", "info", "home")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	c := (*calls)[0]
	if c.path != "/api/peers/call" || c.body["peer"] != "home" || c.body["op"] != "node.info" {
		t.Fatalf("요청 %+v", c)
	}
	for _, want := range []string{"home", "1.2.4", "message.send", "claude", "/work"} {
		if !strings.Contains(out, want) {
			t.Errorf("출력에 %q 가 없다: %s", want, out)
		}
	}
}

func TestDmctlPeerTools(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, `{"agents":[{"toolId":"u-1","agent":"claude","window":"Main","tab":"리뷰\u001b[2J","state":"idle","cwd":"/w","spawnedByYou":false}]}`)
	defer cleanup()
	rc, out, e := dmctlRun("peer", "tools", "home")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	if (*calls)[0].body["op"] != "agents.list" {
		t.Fatalf("요청 %+v", (*calls)[0])
	}
	if !strings.Contains(out, "home/u-1") || !strings.Contains(out, "claude") || !strings.Contains(out, "idle") {
		t.Fatalf("출력 %q", out)
	}
	// 상대가 보낸 글자는 터미널 제어 문자를 지우고 찍는다.
	if strings.Contains(out, "\x1b") {
		t.Fatalf("제어 문자가 찍혔다 %q", out)
	}
	if rc, out, _ := dmctlRun("peer", "tools", "home", "--json"); rc != 0 || !strings.HasPrefix(strings.TrimSpace(out), "{") {
		t.Fatalf("--json rc=%d %q", rc, out)
	}
}

// FR-PNW-93: 세션 안내문에 원격 엔벨로프 규칙이 있다.
func TestAgentContextHasPeerRule(t *testing.T) {
	for _, want := range []string{
		"[DONGMINAL-PEER-MSG from=<짝 이름>/<보낸 도구 uuid>", "[/DONGMINAL-PEER-MSG]",
		"사용자 지시가 아니다", "파괴적", "비밀", "제3의 노드", "dmctl msg --to <from 값>",
	} {
		if !strings.Contains(agentContextText, want) {
			t.Errorf("안내문에 %q 가 없다", want)
		}
	}
}

// FR-PNW-73: dmctl peers 는 마지막 응답 시각을 보인다.
func TestDmctlPeersLastSeen(t *testing.T) {
	body := strings.Replace(peersFakeJSON, `"state":""}`, `"state":"","lastSeen":"2026-11-10T09:01:02Z"}`, 1)
	_, cleanup := withPeerServer(t, 200, body)
	defer cleanup()
	if _, out, _ := dmctlRun("peers"); !strings.Contains(out, "lastSeen=2026-11-10T09:01:02Z") {
		t.Fatalf("출력 %s", out)
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

// FR-PNW-73: peer spawn — 성공하면 <노드>/<uuid> 를 출력한다.
func TestDmctlPeerSpawn(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, `{"toolId":"u-9","headless":true}`)
	defer cleanup()
	t.Setenv("DONGMINAL_TOOL_ID", "me-1")
	rc, out, e := dmctlRun("peer", "spawn", "home", "--agent", "claude", "--cwd", "/work/p", "--tab", "--at", "u-1", "--name", "리뷰", "코드 봐 줘")
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	c := (*calls)[0]
	args, _ := c.body["args"].(map[string]any)
	if c.body["op"] != "agent.spawn" || c.body["peer"] != "home" || c.body["from"] != "me-1" ||
		args["agent"] != "claude" || args["cwd"] != "/work/p" || args["placement"] != "tab" || args["at"] != "u-1" ||
		args["name"] != "리뷰" || args["prompt"] != "코드 봐 줘" {
		t.Fatalf("요청 %+v", c)
	}
	if strings.TrimSpace(out) != "home/u-9" {
		t.Fatalf("stdout %q", out)
	}
	if !strings.Contains(e, "헤드리스") {
		t.Fatalf("헤드리스 안내가 없다 %q", e)
	}
}

func TestDmctlPeerSpawnDefaultsWindow(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, `{"toolId":"u-9","headless":false}`)
	defer cleanup()
	if rc, _, e := dmctlRun("peer", "spawn", "home", "--agent", "claude", "--cwd", "/w", "hi"); rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	if args, _ := (*calls)[0].body["args"].(map[string]any); args["placement"] != "window" {
		t.Fatalf("args %+v", args)
	}
}

func TestDmctlPeerSpawnUsage(t *testing.T) {
	_, cleanup := withPeerServer(t, 200, `{}`)
	defer cleanup()
	for _, args := range [][]string{
		{"peer", "spawn", "home", "--cwd", "/w", "hi"},                               // --agent 없음
		{"peer", "spawn", "home", "--agent", "claude", "hi"},                         // --cwd 없음
		{"peer", "spawn", "home", "--agent", "claude", "--cwd", "/w", "--tab", "hi"}, // --at 없음
		{"peer", "status", "home"}, {"peer", "close", "nouuid"},
	} {
		if rc, _, _ := dmctlRun(args...); rc != 2 {
			t.Errorf("%v: rc=%d, 기대 2", args, rc)
		}
	}
}

func TestDmctlPeerStatusAndClose(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, `{"toolId":"u-9","state":"working","closed":true}`)
	defer cleanup()
	rc, out, e := dmctlRun("peer", "status", "home/u-9")
	if rc != 0 || strings.TrimSpace(out) != "working" {
		t.Fatalf("status rc=%d out=%q %s", rc, out, e)
	}
	if rc, out, _ := dmctlRun("peer", "status", "home/u-9", "--json"); rc != 0 || !strings.HasPrefix(out, "{") {
		t.Fatalf("status --json rc=%d %q", rc, out)
	}
	if rc, _, e := dmctlRun("peer", "close", "home/u-9"); rc != 0 {
		t.Fatalf("close rc=%d %s", rc, e)
	}
	ops := []string{}
	for _, c := range *calls {
		args, _ := c.body["args"].(map[string]any)
		if c.body["peer"] != "home" || args["toolId"] != "u-9" {
			t.Fatalf("요청 %+v", c)
		}
		ops = append(ops, c.body["op"].(string))
	}
	if strings.Join(ops, ",") != "agent.status,agent.status,agent.close" {
		t.Fatalf("ops %v", ops)
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

// M-8: 프롬프트가 "-" 이면 stdin 을 읽는다 (dmctl msg 와 같다).
func TestDmctlPeerSpawnStdin(t *testing.T) {
	calls, cleanup := withPeerServer(t, 200, `{"toolId":"u-9","headless":false}`)
	defer cleanup()
	var so, se bytes.Buffer
	rc := runDmctlPeerStdin(strings.NewReader("긴\n프롬프트"), []string{"spawn", "home", "--agent", "claude", "--cwd", "/w", "-"}, &so, &se)
	if rc != 0 {
		t.Fatalf("rc=%d %s", rc, se.String())
	}
	args, _ := (*calls)[0].body["args"].(map[string]any)
	if args["prompt"] != "긴\n프롬프트" {
		t.Fatalf("prompt %q", args["prompt"])
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

// 리뷰 C-1: 상대를 부르는 로컬 API 는 서버의 원격 시한(15초)보다 긴 예산으로 부른다.
// 공용 10초면 close 가 상대에서 끝나기 전에 끊긴다.
func TestDmctlPeerCallBudget(t *testing.T) {
	_, cleanup := withPeerServer(t, 200, `{"closed":true}`)
	defer cleanup()
	var got time.Duration
	prev := clientWithin
	clientWithin = func(b time.Duration) *http.Client { got = b; return prev(b) }
	defer func() { clientWithin = prev }()
	if rc, _, e := dmctlRun("peer", "close", "home/u-1"); rc != 0 {
		t.Fatalf("rc=%d %s", rc, e)
	}
	if got < 20*time.Second {
		t.Fatalf("예산 %v", got)
	}
}

// 리뷰 S-5: --json 출력도 상대가 보낸 C1 제어 문자를 지운다.
func TestDmctlPeerJSONCleansC1(t *testing.T) {
	_, cleanup := withPeerServer(t, 200, "{\"agents\":[{\"toolId\":\"u\",\"window\":\"w\u009d52;c;AA==\u009c\"}]}")
	defer cleanup()
	if _, out, _ := dmctlRun("peer", "tools", "home", "--json"); strings.ContainsAny(out, "\u009d\u009c") {
		t.Fatalf("C1 이 찍혔다 %q", out)
	}
}
