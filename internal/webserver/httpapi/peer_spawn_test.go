package httpapi

import (
	"errors"
	"net/http"
	"net/http/httptest"
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
	"dongminal/internal/webserver/domain/peer"
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
	// FR-PNW-60: Run 멤버용 사전 허용(dmctl)은 원격 기동에 싣지 않는다 — 받는 노드의 평소 권한으로 돈다.
	if strings.Contains(line, "allowedTools") || strings.Contains(line, "dmctl") {
		t.Fatalf("멤버 인자가 실렸다 %q", line)
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
		// C4: 찾지 못하는 at 은 자리 없이 띄우지 않는다.
		{map[string]any{"agent": "claude", "cwd": b.allowed, "placement": "tab", "at": "t-none"}, 404, "peer_target_not_found"},
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
	code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed, "placement": "tab", "at": "t-at", "name": "review"})
	if code != 200 || out["headless"] != false || out["toolId"] != "headless-1" {
		t.Fatalf("spawn: %d %v", code, out["_raw"])
	}
	var req, rename string
	for _, p := range broker.published {
		if strings.Contains(string(p), `"restoreTool"`) {
			req = string(p)
		}
		if strings.Contains(string(p), `"renameTab"`) {
			rename = string(p)
		}
	}
	if !strings.Contains(req, `"location":"tab-at"`) || !strings.Contains(req, `"toolId":"headless-1"`) {
		t.Fatalf("restoreTool 요청 %s", req)
	}
	// C4: tab 배치도 이름을 붙인다. 붙은 탭을 uuid 로 가리킨다.
	if !strings.Contains(rename, `"location":"tab-h1"`) || !strings.Contains(rename, `"name":"review"`) {
		t.Fatalf("renameTab 요청 %s", rename)
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

// I-47: 첫 프롬프트도 붙여넣기 직전에 전경을 새로 본다.
func TestPeerSpawnPromptFreshForeground(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	b.srv.limits.peerPromptWait = 300 * time.Millisecond
	pairNodes(t, a, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed, "prompt": "hi"}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	b.tools.setFG("headless-1", agentCmd(t))
	b.tools.setFresh("headless-1", "")
	b.reportActivity("headless-1", activity.Idle)
	time.Sleep(600 * time.Millisecond)
	if p := b.tools.pasted(); len(p) != 1 {
		t.Fatalf("셸에 넣었다 %+v", p)
	}
}

// 리뷰 S-7: 도구가 사라지면 프롬프트 대기를 바로 끝낸다.
func TestPeerDeliverPromptStopsWhenToolGone(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	ad, _ := agentadapter.Get("claude")
	done := make(chan struct{})
	go func() { b.srv.peerDeliverPrompt("gone-1", ad, "", "x"); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("죽은 도구 앞에서 기다린다")
	}
}

// 리뷰 C-6: spawn 뒤 정리에서 도구를 닫지 못하면 기록을 남기고(상한에 세고 원격에서 닫을 수
// 있게) 500 internal 로 답한다.
func TestPeerSpawnUndoCloseFailureKeepsRecord(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	b.hub.mu.Lock()
	b.hub.cwds = map[string]string{"headless-1": t.TempDir()}
	b.hub.deleteErr = errors.New("busy")
	b.hub.mu.Unlock()
	code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed})
	if code == 200 || errCode(out) != "internal_error" {
		t.Fatalf("spawn: %d %v", code, out["_raw"])
	}
	if owner, ok := b.srv.peerSpawns.Owner("headless-1"); !ok || owner == "" {
		t.Fatal("닫지 못한 도구의 기록을 지웠다")
	}
}

// 리뷰 C-8: 본문을 읽지 못한 요청의 감사 결과는 실제 응답 상태(413)다. confirm 감사의 짝
// 칸은 저장된 이름이다.
func TestPeerAuditReadFailureAndConfirmName(t *testing.T) {
	logs := captureLog(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	if !regexp.MustCompile(`dir=in peer=node-b op=pair\.confirm`).MatchString(logs.String()) {
		t.Fatalf("confirm 감사에 이름이 없다 %s", logs.String())
	}
	big := `{"to":"t-at","message":"` + strings.Repeat("x", 70<<10) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/peer/v1/message.send", strings.NewReader(big))
	res := b.srv.peerMessageSend(httptest.NewRecorder(), req, peerCaller{name: "node-a"})
	if res.status != http.StatusRequestEntityTooLarge {
		t.Fatalf("감사할 결과 %+v", res)
	}
}

// 재리뷰 C-1: 데몬이 목록을 모르는 동안(재접속 창)은 "도구가 죽었다" 로 읽지 않는다.
// spawn 은 기록을 정리하지 않고 503, close 는 기록을 지우지 않고 실패한다.
func TestPeerSpawnCloseWhenToolListUnknown(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	b.hub.mu.Lock()
	b.hub.listUnknown = true
	b.hub.mu.Unlock()
	b.tools.setHas("headless-1", false) // 모르는 동안의 Has 는 거짓으로 보인다
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code == 200 || errCode(out) != "tools_unavailable" {
		t.Fatalf("모를 때 spawn: %d %v", code, out["_raw"])
	}
	if code, _ := a.call(t, "node-b", "agent.close", map[string]any{"toolId": "headless-1"}); code == 200 {
		t.Fatal("모를 때 close 가 성공했다")
	}
	if _, ok := b.srv.peerSpawns.Owner("headless-1"); !ok {
		t.Fatal("모르는 동안 기록을 지웠다")
	}
}

// I-59: agent.close 가 종료 명령을 보낸 뒤 기다리는 동안 그 도구에는 메시지를 넣지 않는다.
// 에이전트가 끝나는 중이면 넣은 글이 셸에 남아 명령이 될 수 있다.
func TestPeerMessageSendRefusedWhileClosing(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	b.tools.setFG("headless-1", agentCmd(t))
	release := make(chan struct{})
	b.hub.mu.Lock()
	b.hub.busy = func(string) bool {
		select {
		case <-release:
			return false
		default:
			return true
		}
	}
	b.hub.mu.Unlock()
	done := make(chan struct{})
	go func() { a.call(t, "node-b", "agent.close", map[string]any{"toolId": "headless-1"}); close(done) }()
	deadline := time.Now().Add(3 * time.Second)
	for len(b.tools.pasted()) < 2 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	code, out := a.call(t, "node-b", "message.send", map[string]any{"to": "headless-1", "message": "ls\nid"})
	close(release)
	<-done
	if code != http.StatusConflict || errCode(out) != "peer_target_not_agent" {
		t.Fatalf("닫는 중 message.send: %d %v", code, out["_raw"])
	}
	for _, p := range b.tools.pasted() {
		if strings.Contains(p.Text, "ls\nid") || strings.Contains(p.Text, "DONGMINAL-PEER-MSG") {
			t.Fatalf("닫는 중에 넣었다 %+v", p)
		}
	}
}

// 보안 재리뷰 #8: 짝을 해제한 뒤에는 기다리던 첫 프롬프트도 넣지 않는다 (FR-PNW-31).
func TestPeerSpawnPromptDroppedAfterUnpair(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	b.srv.limits.peerPromptWait = 2 * time.Second
	pairNodes(t, a, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed, "prompt": "hi"}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	if code, out := b.api(t, http.MethodPost, "/api/peers/remove", map[string]any{"name": ap0Name(t, b.peerNode)}); code != 200 {
		t.Fatalf("remove %d %v", code, out["_raw"])
	}
	b.tools.setFG("headless-1", agentCmd(t))
	b.reportActivity("headless-1", activity.Idle)
	time.Sleep(500 * time.Millisecond)
	if p := b.tools.pasted(); len(p) != 1 {
		t.Fatalf("해제 뒤에 넣었다 %+v", p)
	}
}

// C9: 기록을 남기지 못해 도구를 닫으려다 그것마저 실패하면, 기록 없는 도구가 남는다는
// 사실을 로그에 남긴다.
func TestPeerSpawnRecordFailureCloseFailureLogged(t *testing.T) {
	installFakeAgent(t)
	logs := captureLog(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	b.srv.peerSpawns = peer.OpenSpawnLog(filepath.Join(blocker, "spawns.json"))
	b.hub.mu.Lock()
	b.hub.deleteErr = errors.New("busy")
	b.hub.mu.Unlock()
	code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed})
	if code == 200 || errCode(out) != "save_failed" {
		t.Fatalf("spawn: %d %v", code, out["_raw"])
	}
	if !strings.Contains(logs.String(), "tool=headless-1") || !strings.Contains(logs.String(), "닫지 못했다") {
		t.Fatalf("닫기 실패가 로그에 없다 %s", logs.String())
	}
}

// 보안 재리뷰(3차) #1: 이미 붙여넣는 중인 원격 메시지를 agent.close 의 종료 명령이 앞지르지
// 않는다. close 는 진행 중인 전달이 끝난 뒤에 "닫는 중" 을 세운다.
func TestPeerAgentCloseWaitsForInflightMessage(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	b.tools.setFG("headless-1", agentCmd(t))
	b.hub.mu.Lock()
	b.hub.busy = func(string) bool { return true }
	b.hub.mu.Unlock()
	gate := make(chan struct{})
	b.tools.fgMu.Lock()
	b.tools.gate, b.tools.entered = gate, make(chan struct{}, 1)
	entered := b.tools.entered
	b.tools.fgMu.Unlock()
	sent := make(chan int, 1)
	go func() {
		code, _ := a.call(t, "node-b", "message.send", map[string]any{"to": "headless-1", "message": "hello"})
		sent <- code
	}()
	<-entered
	closed := make(chan struct{})
	go func() { a.call(t, "node-b", "agent.close", map[string]any{"toolId": "headless-1"}); close(closed) }()
	// close 가 표시를 세우고 진행 중인 전달을 기다리는 상태에 들어간 것을 확인한 뒤 연다.
	deadline := time.Now().Add(5 * time.Second)
	for {
		b.srv.peerGate.mu.Lock()
		st := b.srv.peerGate.m["headless-1"]
		waiting := st != nil && st.closing && st.idle != nil
		b.srv.peerGate.mu.Unlock()
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			close(gate)
			t.Fatal("close 가 진행 중인 전달을 기다리지 않았다")
		}
		time.Sleep(5 * time.Millisecond)
	}
	before := len(b.tools.pasted())
	close(gate)
	if code := <-sent; code != http.StatusOK {
		t.Fatalf("message.send %d", code)
	}
	<-closed
	if before != 1 {
		t.Fatalf("메시지가 끝나기 전에 close 가 무언가 넣었다 (붙여넣기 %d)", before)
	}
	p := b.tools.pasted()
	if len(p) < 2 || !strings.Contains(p[1].Text, "hello") {
		t.Fatalf("순서 %+v", p)
	}
}

// 보안 재리뷰(4차) #1·#4: 한 도구에는 원격 전달이 동시에 1건이다. 넘친 요청은 기다리지 않고
// 409 peer_target_busy 로 거절한다 — 데몬의 도구별 줄이 길어져 연결 시한을 넘지 않게 한다.
func TestPeerMessageSendBusyWhileInflight(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	b.tools.setFG("headless-1", agentCmd(t))
	gate := make(chan struct{})
	b.tools.fgMu.Lock()
	b.tools.gate, b.tools.entered = gate, make(chan struct{}, 1)
	entered := b.tools.entered
	b.tools.fgMu.Unlock()
	sent := make(chan int, 1)
	go func() {
		code, _ := a.call(t, "node-b", "message.send", map[string]any{"to": "headless-1", "message": "one"})
		sent <- code
	}()
	<-entered
	code, out := a.call(t, "node-b", "message.send", map[string]any{"to": "headless-1", "message": "two"})
	close(gate)
	if code != http.StatusConflict || errCode(out) != "peer_target_busy" {
		t.Fatalf("두 번째: %d %v", code, out["_raw"])
	}
	if c := <-sent; c != http.StatusOK {
		t.Fatalf("첫 번째 %d", c)
	}
	// 끝난 뒤에는 다시 받는다.
	b.tools.fgMu.Lock()
	b.tools.gate = nil
	b.tools.fgMu.Unlock()
	if code, out := a.call(t, "node-b", "message.send", map[string]any{"to": "headless-1", "message": "three"}); code != http.StatusOK {
		t.Fatalf("세 번째: %d %v", code, out["_raw"])
	}
}

// 최종 보안 리뷰: 같은 도구에 agent.close 가 겹치면 뒤의 close 는 409 peer_target_busy 로
// 거절하고, 종료 명령은 한 번만 들어간다.
func TestPeerAgentCloseOverlapRejected(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	b.tools.setFG("headless-1", agentCmd(t))
	release := make(chan struct{})
	b.hub.mu.Lock()
	b.hub.busy = func(string) bool {
		select {
		case <-release:
			return false
		default:
			return true
		}
	}
	b.hub.mu.Unlock()
	launch := len(b.tools.pasted())
	first := make(chan int, 1)
	go func() {
		code, _ := a.call(t, "node-b", "agent.close", map[string]any{"toolId": "headless-1"})
		first <- code
	}()
	deadline := time.Now().Add(5 * time.Second)
	for len(b.tools.pasted()) == launch {
		if time.Now().After(deadline) {
			close(release)
			t.Fatal("첫 close 가 종료 명령을 보내지 않았다")
		}
		time.Sleep(5 * time.Millisecond)
	}
	code, out := a.call(t, "node-b", "agent.close", map[string]any{"toolId": "headless-1"})
	close(release)
	if code != http.StatusConflict || errCode(out) != "peer_target_busy" {
		t.Fatalf("겹친 close: %d %v", code, out["_raw"])
	}
	if c := <-first; c != http.StatusOK {
		t.Fatalf("첫 close %d", c)
	}
	if n := len(b.tools.pasted()) - launch; n != 1 {
		t.Fatalf("종료 명령 %d번", n)
	}
}

// 최종 정확성 리뷰: 전달을 기다린 시간과 종료를 기다린 시간은 시한 하나(peerCloseWait)를
// 나눠 쓴다. 둘을 더하면 부른 쪽 시한(15초)을 넘어 닫고도 실패로 보였다.
func TestPeerAgentCloseSharesOneBudget(t *testing.T) {
	installFakeAgent(t)
	a := newPeerNode(t, "node-a", true)
	b := newSpawnNode(t, "node-b", nil)
	pairNodes(t, a, b.peerNode)
	if code, out := a.spawn(t, "node-b", map[string]any{"agent": "claude", "cwd": b.allowed}); code != 200 {
		t.Fatalf("spawn %d %v", code, out["_raw"])
	}
	b.srv.limits.peerCloseWait = time.Second
	b.srv.limits.peerTabCloseWait = 100 * time.Millisecond
	b.tools.setFG("headless-1", agentCmd(t))
	b.hub.mu.Lock()
	b.hub.busy = func(string) bool { return true } // 에이전트가 끝나지 않는다
	b.hub.mu.Unlock()
	gate := make(chan struct{})
	b.tools.fgMu.Lock()
	b.tools.gate, b.tools.entered = gate, make(chan struct{}, 1)
	entered := b.tools.entered
	b.tools.fgMu.Unlock()
	go a.call(t, "node-b", "message.send", map[string]any{"to": "headless-1", "message": "hi"})
	<-entered
	start := time.Now()
	closed := make(chan struct{})
	go func() { a.call(t, "node-b", "agent.close", map[string]any{"toolId": "headless-1"}); close(closed) }()
	time.AfterFunc(900*time.Millisecond, func() { close(gate) })
	<-closed
	// 나눠 쓰면 약 1s + 탭 닫기 100ms, 따로 쓰면 900ms + 1s + 100ms 다.
	if d := time.Since(start); d > 1600*time.Millisecond {
		t.Fatalf("close 가 %v 걸렸다 — 두 기다림이 시한을 따로 쓴다", d)
	}
}
