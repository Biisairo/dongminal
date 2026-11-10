package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
	line := p[0].Text
	if !strings.Contains(line, agentCmd(t)) || !strings.Contains(line, "DONGMINAL-PEER-MSG from=node-a/caller-1 to=headless-1") {
		t.Fatalf("기동줄 %q", line)
	}
	if strings.Contains(line, "\x1b") {
		t.Fatalf("제어 문자가 남았다 %q", line)
	}
	// FR-PNW-51·62: 띄운 짝에게는 spawnedByYou 다.
	b.tools.setFG("headless-1", agentCmd(t))
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
	if p := b.tools.pasted(); len(p) != 1 || p[0].ToolID != "w-1" {
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
