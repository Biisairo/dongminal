package httpapi

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"dongminal/internal/shared/activity"
	"dongminal/internal/shared/agentadapter"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/testpath"
	"dongminal/internal/webserver/hub"
	"dongminal/internal/webserver/seam/toolaccess"
)

// spawnNode 는 agent.spawn 을 받을 수 있는 노드다 — 허용 폴더 하나와 가짜 도구 허브.
type spawnNode struct {
	*peerNode
	tools   *peerFakeTools
	hub     *headlessHub
	broker  *fakeCommandBroker
	allowed string
}

// installFakeAgent 는 등록부의 claude 실행 파일을 DONGMINAL_AGENT_BIN_DIR 에 둔다.
func installFakeAgent(t *testing.T) {
	t.Helper()
	if !testpath.PermChecked() {
		t.Skip("실행 비트로 가짜 에이전트를 만드는 검사다")
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, agentCmd(t)), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(dmenv.EnvAgentBinDir, bin)
}

func newSpawnNode(t *testing.T, name string, broker *fakeCommandBroker) *spawnNode {
	t.Helper()
	tools := &peerFakeTools{fakeToolIO: newFakeToolIO(), fg: map[string]string{}}
	hh := newHeadlessHub(tools.fakeToolIO)
	wi := &fakeWorkIndex{resolve: map[string]string{"caller-1": "caller-1", "t-at": "t-at"},
		entries: []toolaccess.WorkspaceEntry{{ToolID: "t-at", TabUUID: "tab-at", WindowName: "Main", TabName: "x"}},
		coords:  map[string]string{"tab-at": "W1.P1.T1"}}
	for i := 1; i <= 9; i++ {
		id := "headless-" + itoa(i)
		wi.resolve[id] = id
	}
	wi.resolve["w-1"] = "w-1"
	deps := Deps{ToolIO: tools, WorkIndex: wi, Tools: hh}
	if broker != nil {
		deps.Commands = broker
	}
	n := newPeerNodeWith(t, name, true, deps)
	allowed := t.TempDir()
	cfg := n.srv.peers.Config()
	cfg.AllowedDirs = []string{allowed}
	if err := n.srv.peers.SetNode(cfg); err != nil {
		t.Fatal(err)
	}
	return &spawnNode{peerNode: n, tools: tools, hub: hh, broker: broker, allowed: allowed}
}

func (a *peerNode) spawn(t *testing.T, peerName string, args map[string]any) (int, map[string]any) {
	t.Helper()
	return a.api(t, http.MethodPost, "/api/peers/call", map[string]any{"peer": peerName, "op": "agent.spawn", "from": "caller-1", "args": args})
}

// FR-PNW-53·58·59·60·61: 브라우저가 없으면 헤드리스로 띄우고, 기동줄은 등록부의 것이며
// 첫 프롬프트는 원격 엔벨로프로 감싼다.
func TestPeerSpawnHeadless(t *testing.T) {
	installFakeAgent(t)
	a, _ := newPeerNodeTools(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	cwd := filepath.Join(b.allowed, "proj")
	if err := os.MkdirAll(cwd, 0o700); err != nil {
		t.Fatal(err)
	}
	code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": cwd, "prompt": "리뷰\x1b[201~해 줘", "placement": "window"})
	if code != http.StatusOK || out["headless"] != true || out["toolId"] != "headless-1" {
		t.Fatalf("spawn: %d %v", code, out["_raw"])
	}
	created, _, _ := b.hub.counts()
	if created != 1 || b.hub.lastPlacement().Command != "" {
		t.Fatalf("셸 도구 하나를 만들어야 한다: created=%d place=%+v", created, b.hub.lastPlacement())
	}
	real, _ := filepath.EvalSymlinks(cwd)
	if b.hub.lastCwd != real {
		t.Fatalf("cwd %q, 기대 %q", b.hub.lastCwd, real)
	}
	p := b.tools.pasted()
	if len(p) != 1 || p[0].ToolID != "headless-1" || !p[0].Submit {
		t.Fatalf("기동줄 붙여넣기 %+v", p)
	}
	// I-30: 원격 프롬프트는 셸 명령줄에 들어가지 않는다.
	line := p[0].Text
	if !strings.Contains(line, agentCmd(t)) || strings.Contains(line, "DONGMINAL-PEER-MSG") || strings.Contains(line, "리뷰") {
		t.Fatalf("기동줄 %q", line)
	}
	// 에이전트가 전경에 오르고 준비완료를 알리면 엔벨로프를 에이전트 입력에 넣는다.
	b.tools.setFG("headless-1", agentCmd(t))
	b.reportActivity("headless-1", activity.Idle)
	p = b.awaitPastes(t, 2)
	env := p[1]
	if env.ToolID != "headless-1" || !env.Submit || !strings.Contains(env.Text, "DONGMINAL-PEER-MSG from=node-a/caller-1 to=headless-1") {
		t.Fatalf("프롬프트 붙여넣기 %+v", env)
	}
	if strings.Contains(env.Text, "\x1b") {
		t.Fatalf("제어 문자가 남았다 %q", env.Text)
	}
	// FR-PNW-51·62: 띄운 짝에게는 spawnedByYou 다.
	_, list := a.call(t, "node-b", "agents.list", nil)
	if items := listOf(list, "agents"); len(items) != 1 || items[0]["spawnedByYou"] != true {
		t.Fatalf("agents.list %v", list["_raw"])
	}
}

// FR-PNW-61: 브라우저가 있으면 placement=window 는 새 창의 셸에 띄운다.
func TestPeerSpawnWindow(t *testing.T) {
	installFakeAgent(t)
	broker := &fakeCommandBroker{awaitDelivered: 1, awaitResult: hub.CmdResult{NewTabs: []hub.TabRef{{UUID: "tab-w", ToolID: "w-1"}}}}
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", broker)
	b.tools.setHas("w-1", true)
	pairNodes(t, a, b.peerNode)
	code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed, "prompt": "hi", "placement": "window", "name": "리뷰"})
	if code != http.StatusOK || out["headless"] != false || out["toolId"] != "w-1" {
		t.Fatalf("spawn: %d %v", code, out["_raw"])
	}
	if created, _, _ := b.hub.counts(); created != 0 {
		t.Fatal("창 배치인데 헤드리스 도구를 만들었다")
	}
	if p := b.tools.pasted(); len(p) != 1 || p[0].ToolID != "w-1" || strings.Contains(p[0].Text, "hi") {
		t.Fatalf("붙여넣기 %+v", p)
	}
	// 짝맞춤이 먼저 `peers_changed` 를 민다 — 새 창 요청은 그 뒤에 있다.
	var req []byte
	for _, p := range broker.published {
		if strings.Contains(string(p), `"newWindow"`) {
			req = p
		}
	}
	if req == nil || !strings.Contains(string(req), b.allowed) {
		t.Fatalf("newWindow 요청 %s", req)
	}
}

// FR-PNW-58·59·43: 거절. 거절이면 아무것도 만들지 않는다.
func TestPeerSpawnRefusals(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	outside := t.TempDir()
	cases := []struct {
		args   map[string]any
		status int
		code   string
	}{
		{map[string]any{"agent": "nope", "cwd": b.allowed}, 400, "peer_agent_unavailable"},
		{map[string]any{"agent": "claude", "cwd": outside}, 403, "peer_dir_not_allowed"},
		{map[string]any{"agent": "claude", "cwd": "relative"}, 403, "peer_dir_not_allowed"},
		{map[string]any{"agent": "claude", "cwd": b.allowed, "prompt": strings.Repeat("x", 16<<10+1)}, 413, "body_too_large"},
		{map[string]any{"agent": "claude", "cwd": b.allowed, "placement": "tab"}, 400, "missing_argument"},
		{map[string]any{"agent": "claude", "cwd": b.allowed, "placement": "floor"}, 400, "bad_request"},
	}
	for _, c := range cases {
		code, out := a.spawn(t, "node-b", c.args)
		if code != c.status || errCode(out) != c.code {
			t.Errorf("%v: %d %v", c.args, code, out["_raw"])
		}
	}
	// 설치되지 않은 에이전트.
	t.Setenv(dmenv.EnvAgentBinDir, t.TempDir())
	t.Setenv("PATH", t.TempDir())
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 400 || errCode(out) != "peer_agent_unavailable" {
		t.Errorf("미설치: %d %v", code, out["_raw"])
	}
	// FR-PNW-59: 허용 폴더가 비면 모든 spawn 을 거절한다.
	cfg := b.srv.peers.Config()
	cfg.AllowedDirs = nil
	_ = b.srv.peers.SetNode(cfg)
	installFakeAgent(t)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 403 || errCode(out) != "peer_dir_not_allowed" {
		t.Errorf("빈 허용 폴더: %d %v", code, out["_raw"])
	}
	if created, _, _ := b.hub.counts(); created != 0 || len(b.tools.pasted()) != 0 {
		t.Fatal("거절했는데 무언가 만들었다")
	}
}

// FR-PNW-54·64: 상태. 에이전트가 아니면 ended 다.
func TestPeerAgentStatus(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	status := func(id string) string {
		code, out := a.call(t, "node-b", "agent.status", map[string]any{"toolId": id})
		if code != 200 {
			t.Fatalf("status %d %v", code, out["_raw"])
		}
		return out["state"].(string)
	}
	if got := status("headless-1"); got != "ended" {
		t.Fatalf("셸만 도는 도구 = %q", got)
	}
	b.tools.setFG("headless-1", agentCmd(t))
	if got := status("headless-1"); got == "ended" || got == "done" {
		t.Fatalf("에이전트 도구 = %q", got)
	}
	if got := status("nope"); got != "ended" {
		t.Fatalf("없는 도구 = %q", got)
	}
}

// FR-PNW-63: 띄운 짝만 닫는다. 닫으면 도구가 사라지고 기록도 지운다.
func TestPeerAgentClose(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	c := newPeerNode(t, "node-c", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	pairNodes(t, c, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	if code, out := c.call(t, "node-b", "agent.close", map[string]any{"toolId": "headless-1"}); code != 403 || errCode(out) != "peer_not_owner" {
		t.Fatalf("남의 close: %d %v", code, out["_raw"])
	}
	if code, out := a.call(t, "node-b", "agent.close", map[string]any{"toolId": "t-at"}); code != 403 || errCode(out) != "peer_not_owner" {
		t.Fatalf("띄우지 않은 도구 close: %d %v", code, out["_raw"])
	}
	if code, out := a.call(t, "node-b", "agent.close", map[string]any{"toolId": "headless-1"}); code != 200 || out["closed"] != true {
		t.Fatalf("close: %d %v", code, out["_raw"])
	}
	if _, deleted, _ := b.hub.counts(); deleted != 1 {
		t.Fatal("도구를 닫지 않았다")
	}
	if _, ok := b.srv.peerSpawns.Owner("headless-1"); ok {
		t.Fatal("기록이 남았다")
	}
}

func (n *spawnNode) reportActivity(toolID, state string) {
	n.srv.attention().ReportActivity(toolID, state, "", "", false, true)
	n.srv.activityChanged.Notify()
}

// awaitPastes 는 붙여넣기가 n 개가 될 때까지 기다린다 — 프롬프트 전달은 응답 뒤에 일어난다.
func (n *spawnNode) awaitPastes(t *testing.T, want int) []fakePaste {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		p := n.tools.pasted()
		if len(p) >= want {
			return p
		}
		if time.Now().After(deadline) {
			t.Fatalf("붙여넣기 %d 개를 기다렸다: %+v", want, p)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// I-30: 전경이 셸이면 준비완료 신호가 와도 프롬프트를 붙여넣지 않는다 — 셸에 들어가면
// 원격 글이 명령이 된다. 기한이 지나면 버린다.
func TestPeerSpawnPromptNeverToShell(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	b.srv.limits.peerPromptWait = 300 * time.Millisecond
	pairNodes(t, a, b.peerNode)
	code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed, "prompt": "x'; touch /tmp/pwn; echo '"})
	if code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	b.reportActivity("headless-1", activity.Idle)
	time.Sleep(600 * time.Millisecond)
	// 기한이 지난 뒤 에이전트가 떠도 늦은 프롬프트는 오지 않는다.
	b.tools.setFG("headless-1", agentCmd(t))
	b.reportActivity("headless-1", activity.Idle)
	time.Sleep(100 * time.Millisecond)
	if p := b.tools.pasted(); len(p) != 1 {
		t.Fatalf("기동줄 하나만 있어야 한다 %+v", p)
	}
}

// I-30: 전경이 다른 에이전트면 넣지 않는다 — 띄운 그 에이전트여야 한다.
func TestPeerSpawnPromptOtherAgent(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	b.srv.limits.peerPromptWait = 300 * time.Millisecond
	pairNodes(t, a, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed, "prompt": "hi"}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	other, err := agentadapter.Get("codex")
	if err != nil {
		t.Fatal(err)
	}
	b.tools.setFG("headless-1", other.DetectCmd)
	b.reportActivity("headless-1", activity.Idle)
	time.Sleep(600 * time.Millisecond)
	if p := b.tools.pasted(); len(p) != 1 {
		t.Fatalf("다른 에이전트에 넣었다 %+v", p)
	}
}

// I-31: 한 짝이 띄워 살아 있는 도구는 4개까지다. 죽은 도구의 기록은 셀 때 지운다.
func TestPeerSpawnLimit(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	for i := 0; i < 4; i++ {
		if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 200 {
			t.Fatalf("spawn %d: %d %v", i, code, out["_raw"])
		}
	}
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != http.StatusTooManyRequests || errCode(out) != "peer_spawn_limit" {
		t.Fatalf("상한: %d %v", code, out["_raw"])
	}
	if created, _, _ := b.hub.counts(); created != 4 {
		t.Fatalf("거절했는데 만들었다: %d", created)
	}
	b.tools.setHas("headless-2", false)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 200 {
		t.Fatalf("하나가 죽은 뒤: %d %v", code, out["_raw"])
	}
	if _, ok := b.srv.peerSpawns.Owner("headless-2"); ok {
		t.Fatal("죽은 도구의 기록이 남았다")
	}
}

// I-32: spawn 이 도구를 만든 뒤 실패하면 도구를 닫고 기록을 지운다.
func TestPeerSpawnFailureCleansUp(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	b.tools.fakeToolIO.pasteErr = errors.New("pty gone")
	if code, _ := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != http.StatusBadGateway {
		t.Fatalf("spawn = %d", code)
	}
	if _, deleted, _ := b.hub.counts(); deleted != 1 {
		t.Fatal("실패한 도구가 남았다")
	}
	if _, ok := b.srv.peerSpawns.Owner("headless-1"); ok {
		t.Fatal("실패한 도구의 기록이 남았다")
	}
}

// I-32: 화면이 closeTab 을 받고도 닫지 않으면 서버가 지운다.
func TestPeerAgentCloseFallsBackToDelete(t *testing.T) {
	installFakeAgent(t)
	broker := &fakeCommandBroker{}
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", broker)
	b.srv.limits.peerTabCloseWait = 100 * time.Millisecond
	pairNodes(t, a, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	wi := b.srv.WorkIndex.(*fakeWorkIndex)
	wi.entries = append(wi.entries, toolaccess.WorkspaceEntry{ToolID: "headless-1", TabUUID: "tab-h1"})
	if code, out := a.call(t, "node-b", "agent.close", map[string]any{"toolId": "headless-1"}); code != 200 || out["closed"] != true {
		t.Fatalf("close: %d %v", code, out["_raw"])
	}
	if b.srv.toolLive("headless-1") {
		t.Fatal("도구가 살아 있다")
	}
	if _, ok := b.srv.peerSpawns.Owner("headless-1"); ok {
		t.Fatal("기록이 남았다")
	}
}

// I-33: 창 배치가 시간 초과면 헤드리스로 내려가지 않는다.
func TestPeerSpawnWindowTimeout(t *testing.T) {
	installFakeAgent(t)
	broker := &fakeCommandBroker{awaitDelivered: 1, awaitTimedOut: true}
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", broker)
	pairNodes(t, a, b.peerNode)
	if code, _ := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code == 200 {
		t.Fatal("시간 초과인데 성공했다")
	}
	if created, _, _ := b.hub.counts(); created != 0 {
		t.Fatal("헤드리스 셸을 만들었다")
	}
}

// L-3 (FR-PNW-94): 나가는 방향도 대상 uuid·본문 길이·실제 결과 코드를 남긴다.
func TestPeerAuditOutbound(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	logs := captureLog(t)
	if code, _ := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed, "prompt": "12345"}); code != 200 {
		t.Fatal("spawn")
	}
	audit := func(op, target, rest string) bool {
		return regexp.MustCompile(`dir=out peer=node-b op=` + regexp.QuoteMeta(op) + ` target=\\?"` + target + `\\?" ` + rest).MatchString(logs.String())
	}
	if !audit("agent.spawn", "headless-1", "len=5 status=200") {
		t.Fatalf("spawn 감사 %s", logs.String())
	}
	if code, _ := a.call(t, "node-b", "agent.close", map[string]any{"toolId": "t-at"}); code != 403 {
		t.Fatal("close")
	}
	if !audit("agent.close", "t-at", "len=0 status=403") {
		t.Fatalf("close 감사 %s", logs.String())
	}
}

// L-12: 판정과 생성 사이에 경로가 바뀌어 셸이 허용 폴더 밖에 서면 기동줄을 넣지 않고 닫는다.
func TestPeerSpawnRechecksActualCwd(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	b.hub.mu.Lock()
	b.hub.cwds = map[string]string{"headless-1": t.TempDir()}
	b.hub.mu.Unlock()
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != http.StatusForbidden || errCode(out) != "peer_dir_not_allowed" {
		t.Fatalf("spawn: %d %v", code, out["_raw"])
	}
	if len(b.tools.pasted()) != 0 {
		t.Fatal("기동줄을 넣었다")
	}
	if _, deleted, _ := b.hub.counts(); deleted != 1 {
		t.Fatal("도구를 닫지 않았다")
	}
}

// FR-PNW-61 · I-18: --tab 은 헤드리스 셸을 at 도구의 칸에 붙인다.
func TestPeerSpawnTabPlacement(t *testing.T) {
	installFakeAgent(t)
	broker := &fakeCommandBroker{}
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", broker)
	pairNodes(t, a, b.peerNode)
	wi := b.srv.WorkIndex.(*fakeWorkIndex)
	wi.entries = append(wi.entries, toolaccess.WorkspaceEntry{ToolID: "headless-1", TabUUID: "tab-h1"})
	code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed, "placement": "tab", "at": "t-at"})
	if code != 200 || out["headless"] != false || out["toolId"] != "headless-1" {
		t.Fatalf("spawn: %d %v", code, out["_raw"])
	}
	var req string
	for _, p := range broker.published {
		if strings.Contains(string(p), `"restoreTool"`) {
			req = string(p)
		}
	}
	if !strings.Contains(req, `"location":"W1.P1.T1"`) || !strings.Contains(req, `"toolId":"headless-1"`) {
		t.Fatalf("restoreTool 요청 %s", req)
	}
}

// FR-PNW-63: 에이전트가 일하는 중이면 종료 명령을 먼저 보낸 뒤 닫는다.
func TestPeerAgentCloseSendsExitWhenBusy(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	b.tools.setFG("headless-1", agentCmd(t))
	b.hub.mu.Lock()
	b.hub.busy = func(string) bool { return len(b.tools.pasted()) < 2 }
	b.hub.mu.Unlock()
	if code, out := a.call(t, "node-b", "agent.close", map[string]any{"toolId": "headless-1"}); code != 200 {
		t.Fatalf("close: %d %v", code, out["_raw"])
	}
	ad, _ := agentadapter.Get("claude")
	p := b.tools.pasted()
	if len(p) != 2 || p[1].Text != ad.ExitCommand {
		t.Fatalf("종료 명령 %+v", p)
	}
	if b.srv.toolLive("headless-1") {
		t.Fatal("도구가 살아 있다")
	}
}
