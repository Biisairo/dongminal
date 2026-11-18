package edgenode

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"testing"
	"time"

	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgemesh"
)

// EDGE_MESH_SRS — 노드에 붙은 간선 계층 (TC-EGM-5~8·11·13).

func pairNodes(t *testing.T, a, b *testNode) {
	t.Helper()
	inv := b.do(t, "invite", map[string]any{})
	code, _ := body(t, inv)["code"].(string)
	if add := a.do(t, "add", map[string]any{"code": code}); add.Status != http.StatusOK {
		t.Fatalf("add %d %s %s", add.Status, add.Code, add.Message)
	}
}

func targetOf(t *testing.T, tn *testNode) edge.Target {
	t.Helper()
	host, port, _ := net.SplitHostPort(tn.ln.Status().Addr)
	p, _ := strconv.Atoi(port)
	return edge.Target{Addr: host, Port: p, Fingerprint: tn.Identity().Fingerprint}
}

func newMeshNode(t *testing.T, name string) *testNode {
	t.Helper()
	tn := newTestNodeOpts(t, name, true)
	t.Cleanup(tn.Close)
	return tn
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("시간 안에 이루어지지 않았다: %s", what)
}

type meshGet struct {
	Edges []struct {
		FP       string `json:"fp"`
		Name     string `json:"name"`
		Pending  bool   `json:"pending"`
		Linked   bool   `json:"linked"`
		Outdated bool   `json:"outdated"`
	} `json:"edges"`
	Mesh *struct {
		Nodes []struct {
			FP     string `json:"fp"`
			Name   string `json:"name"`
			Tag    string `json:"tag"`
			Online bool   `json:"online"`
			Self   bool   `json:"self"`
			Edge   bool   `json:"edge"`
		} `json:"nodes"`
		Links [][2]string `json:"links"`
	} `json:"mesh"`
	Invites []struct {
		ID      string `json:"id"`
		From    string `json:"from"`
		Name    string `json:"name"`
		Tag     string `json:"tag"`
		Expires string `json:"expires"`
	} `json:"invites"`
}

func getView(t *testing.T, tn *testNode) meshGet {
	t.Helper()
	r := tn.do(t, "get", nil)
	var v meshGet
	if err := json.Unmarshal(r.Body, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func edgeState(t *testing.T, tn *testNode, fp string) (name string, pending, linked, outdated bool) {
	t.Helper()
	for _, e := range getView(t, tn).Edges {
		if e.FP == fp {
			return e.Name, e.Pending, e.Linked, e.Outdated
		}
	}
	t.Fatalf("간선 %s 가 없다", fp[:8])
	return
}

func notify(t *testing.T, from, to *testNode) Response {
	t.Helper()
	return from.do(t, "notify", map[string]any{"fp": to.Identity().Fingerprint})
}

func fpOf(tn *testNode) string { return tn.Identity().Fingerprint }

// FR-EGM-1: 간선 계층이 없는 노드(Options.Mesh 거짓)의 간선 연결 경로는 404 다.
func TestLinkPathWithoutMeshIs404(t *testing.T) {
	a, b := newTestNode(t, "node-a"), newTestNode(t, "node-b")
	pairNodes(t, a, b)
	_, err := edge.NewClient(a.Identity()).Upgrade(context.Background(), targetOf(t, b), edgemesh.Path, edgemesh.Proto)
	var re *edge.RemoteError
	if !errors.As(err, &re) || re.Status != http.StatusNotFound {
		t.Fatalf("err = %v, want 404", err)
	}
}

// FR-EGM-2: 간선 연결 경로는 간선만 닿는다.
func TestLinkPathRejectsNonEdge(t *testing.T) {
	b := newMeshNode(t, "node-b")
	stranger := newTestNode(t, "stranger")
	_, err := edge.NewClient(stranger.Identity()).Upgrade(context.Background(), targetOf(t, b), edgemesh.Path, edgemesh.Proto)
	if !IsNotEdge(err) {
		t.Fatalf("err = %v, want edge_not_edge", err)
	}
}

// TC-EGM-8 (FR-EGM-2·7): 옛 경로 /edge/v1/chat 은 404 이고, 그렇게 걸어 온 간선은 옛 판이다.
func TestLegacyChatPathMarksOutdated(t *testing.T) {
	a, b := newTestNode(t, "node-a"), newMeshNode(t, "node-b")
	pairNodes(t, a, b)
	_, err := edge.NewClient(a.Identity()).Upgrade(context.Background(), targetOf(t, b), "/edge/v1/chat", "dmchat1")
	var re *edge.RemoteError
	if !errors.As(err, &re) || re.Status != http.StatusNotFound {
		t.Fatalf("err = %v, want 404", err)
	}
	eventually(t, "B 가 A 를 옛 판으로 본다", func() bool { _, _, _, o := edgeState(t, b, fpOf(a)); return o })
}

// TC-EGM-5·7 (FR-EGM-21·26): 알리기로 연결을 맺으면 양쪽이 hello 를 주고받아 상대 이름을 고친다.
func TestNotifyLinksAndExchangesHello(t *testing.T) {
	a, b := newMeshNode(t, "node-a"), newMeshNode(t, "node-b")
	pairNodes(t, a, b)
	if err := b.Store().SetName("node-b2"); err != nil {
		t.Fatal(err)
	}
	if r := notify(t, a, b); r.Status != http.StatusOK {
		t.Fatalf("notify %d %s %s", r.Status, r.Code, r.Message)
	}
	eventually(t, "A 가 B 의 새 이름을 안다", func() bool { n, _, _, _ := edgeState(t, a, fpOf(b)); return n == "node-b2" })
	_, _, linked, _ := edgeState(t, a, fpOf(b))
	if !linked {
		t.Fatal("연결이 남는다")
	}
	v := getView(t, a)
	if v.Mesh == nil || len(v.Mesh.Nodes) != 2 || len(v.Mesh.Links) != 1 {
		t.Fatalf("mesh = %+v", v.Mesh)
	}
	for _, n := range v.Mesh.Nodes {
		if n.FP == fpOf(b) && (!n.Online || !n.Edge || n.Tag != edge.Tag(fpOf(b)) || n.Name != "node-b2") {
			t.Fatalf("B 노드 = %+v", n)
		}
	}
}

// TC-EGM-6 (FR-EGM-22~25): 이름을 바꾸면 연결된 간선은 알림 대기가 곧 지워지고, 끊긴 간선은 남는다.
func TestRenameMarksPendingUntilSent(t *testing.T) {
	a, b, c := newMeshNode(t, "node-a"), newMeshNode(t, "node-b"), newMeshNode(t, "node-c")
	pairNodes(t, a, b)
	pairNodes(t, a, c)
	if r := notify(t, a, b); r.Status != http.StatusOK {
		t.Fatalf("notify %d %s", r.Status, r.Code)
	}
	if r := a.do(t, "profile_name", map[string]any{"name": "node-a2"}); r.Status != http.StatusOK {
		t.Fatalf("profile_name %d %s", r.Status, r.Code)
	}
	eventually(t, "B 는 받았다", func() bool { _, p, _, _ := edgeState(t, a, fpOf(b)); return !p })
	if _, p, _, _ := edgeState(t, a, fpOf(c)); !p {
		t.Fatal("C 는 알림 대기다")
	}
	eventually(t, "B 가 새 이름을 안다", func() bool { n, _, _, _ := edgeState(t, b, fpOf(a)); return n == "node-a2" })
	if r := notify(t, a, c); r.Status != http.StatusOK {
		t.Fatalf("notify C %d %s", r.Status, r.Code)
	}
	if _, p, _, _ := edgeState(t, a, fpOf(c)); p {
		t.Fatal("알린 뒤에는 알림 대기가 없다")
	}
	if n, _, _, _ := edgeState(t, c, fpOf(a)); n != "node-a2" {
		t.Fatalf("C 가 아는 이름 = %q", n)
	}
}

// FR-EGM-22: 노드 포트를 끄기만 한 것은 알리지 않는다.
func TestPortOffIsNotNotified(t *testing.T) {
	a, b := newMeshNode(t, "node-a"), newMeshNode(t, "node-b")
	pairNodes(t, a, b)
	closePort(t, a)
	if _, p, _, _ := edgeState(t, a, fpOf(b)); p {
		t.Fatal("노드 포트를 끈 것은 알림 대기를 만들지 않는다")
	}
}

// FR-EGM-22·23: 노드 포트 번호를 바꾸면 알림 대기가 되고, 연결된 상대의 주소가 바뀐다.
func TestPortChangeUpdatesPeer(t *testing.T) {
	a, b := newMeshNode(t, "node-a"), newMeshNode(t, "node-b")
	pairNodes(t, b, a)
	if r := notify(t, b, a); r.Status != http.StatusOK {
		t.Fatalf("notify %d %s", r.Status, r.Code)
	}
	cfg := a.Config()
	cfg.Port = freePort(t)
	raw, _ := json.Marshal(cfg)
	if r := a.Do(context.Background(), Request{Op: "node", Args: raw}); r.Status != http.StatusOK {
		t.Fatalf("node %d %s", r.Status, r.Code)
	}
	eventually(t, "B 가 A 의 새 포트를 안다", func() bool {
		e, _ := b.Store().Resolve(fpOf(a))
		return e.Port == cfg.Port && e.Addr == "127.0.0.1"
	})
}

// TC-EGM-7 (FR-EGM-26): 주소를 모르면 409, 옛 판이면 502 edge_peer_outdated, 닿지 않으면 502.
func TestNotifyFailures(t *testing.T) {
	a, b := newMeshNode(t, "node-a"), newMeshNode(t, "node-b")
	closePort(t, a)
	pairNodes(t, a, b)
	if r := notify(t, b, a); r.Status != http.StatusConflict || r.Code != edge.CodeAddrUnknown {
		t.Fatalf("주소 모름 = %d %s", r.Status, r.Code)
	}
	old := newTestNode(t, "node-old")
	pairNodes(t, a, old)
	if r := notify(t, a, old); r.Status != http.StatusBadGateway || r.Code != edge.CodePeerOutdated {
		t.Fatalf("옛 판 = %d %s", r.Status, r.Code)
	}
	if _, _, _, o := edgeState(t, a, fpOf(old)); !o {
		t.Fatal("옛 판 표시")
	}
	b.ln.Close()
	if r := notify(t, a, b); r.Status != http.StatusBadGateway || r.Code != edge.CodeUnreachable {
		t.Fatalf("닿지 않음 = %d %s", r.Status, r.Code)
	}
	if r := a.do(t, "notify", map[string]any{"fp": "zzzzzzzzzz"}); r.Status != http.StatusNotFound {
		t.Fatalf("없는 간선 = %d %s", r.Status, r.Code)
	}
}

// TC-EGM-11 (FR-EGM-30~35): A-B-C 에서 A 가 C 에 초대를 보내고, C 가 맺는다.
func TestInviteSendAndAccept(t *testing.T) {
	a, b, c := newMeshNode(t, "node-a"), newMeshNode(t, "node-b"), newMeshNode(t, "node-c")
	pairNodes(t, a, b)
	pairNodes(t, c, b)
	if r := notify(t, a, b); r.Status != http.StatusOK {
		t.Fatalf("notify %d %s", r.Status, r.Code)
	}
	if r := notify(t, c, b); r.Status != http.StatusOK {
		t.Fatalf("notify %d %s", r.Status, r.Code)
	}
	eventually(t, "A 가 C 를 온라인으로 안다", func() bool {
		for _, n := range getView(t, a).Mesh.Nodes {
			if n.FP == fpOf(c) {
				return n.Online && !n.Edge
			}
		}
		return false
	})
	if r := a.do(t, "invite_send", map[string]any{"to": fpOf(a)}); r.Status != http.StatusBadRequest {
		t.Fatalf("자기에게 = %d %s", r.Status, r.Code)
	}
	if r := a.do(t, "invite_send", map[string]any{"to": fpOf(b)}); r.Status != http.StatusConflict || r.Code != edge.CodeAlreadyEdge {
		t.Fatalf("이미 간선 = %d %s", r.Status, r.Code)
	}
	if r := a.do(t, "invite_send", map[string]any{"to": "ff"}); r.Status != http.StatusNotFound || r.Code != edge.CodeNotFound {
		t.Fatalf("모르는 노드 = %d %s", r.Status, r.Code)
	}
	r := a.do(t, "invite_send", map[string]any{"to": fpOf(c)})
	if r.Status != http.StatusOK {
		t.Fatalf("invite_send %d %s %s", r.Status, r.Code, r.Message)
	}
	if got := body(t, r); got["to"] != fpOf(c) || got["name"] != "node-c" || got["expires"] == nil {
		t.Fatalf("답 = %v", got)
	}
	eventually(t, "C 가 초대를 받는다", func() bool { return len(getView(t, c).Invites) == 1 })
	inv := getView(t, c).Invites[0]
	if inv.From != fpOf(a) || inv.Name != "node-a" || inv.Tag != edge.Tag(fpOf(a)) {
		t.Fatalf("받은 초대 = %+v", inv)
	}
	if len(getView(t, b).Invites) != 0 {
		t.Fatal("B 는 초대를 받지 않는다")
	}
	invited := false
	for _, ch := range c.changes() {
		if ch.Invited != nil && ch.Invited.FP == fpOf(a) {
			invited = true
		}
	}
	if !invited {
		t.Fatal("받으면 invited 로 알린다")
	}
	acc := c.do(t, "invite_accept", map[string]any{"id": inv.ID})
	if acc.Status != http.StatusOK {
		t.Fatalf("accept %d %s %s", acc.Status, acc.Code, acc.Message)
	}
	if !a.Store().IsEdge(fpOf(c)) || !c.Store().IsEdge(fpOf(a)) {
		t.Fatal("A·C 가 간선이 아니다")
	}
	if len(getView(t, c).Invites) != 0 {
		t.Fatal("맺은 초대는 지운다")
	}
	if r := c.do(t, "invite_accept", map[string]any{"id": inv.ID}); r.Status != http.StatusNotFound {
		t.Fatalf("없는 초대 = %d %s", r.Status, r.Code)
	}
}

// FR-EGM-35: 거절은 목록에서 지우기만 한다.
func TestInviteReject(t *testing.T) {
	a, b, c := newMeshNode(t, "node-a"), newMeshNode(t, "node-b"), newMeshNode(t, "node-c")
	pairNodes(t, a, b)
	pairNodes(t, c, b)
	notify(t, a, b)
	notify(t, c, b)
	eventually(t, "A 가 C 를 안다", func() bool {
		r := a.do(t, "invite_send", map[string]any{"to": fpOf(c)})
		return r.Status == http.StatusOK
	})
	eventually(t, "C 가 초대를 받는다", func() bool { return len(getView(t, c).Invites) == 1 })
	id := getView(t, c).Invites[0].ID
	if r := c.do(t, "invite_reject", map[string]any{"id": id}); r.Status != http.StatusOK {
		t.Fatalf("reject %d %s", r.Status, r.Code)
	}
	if len(getView(t, c).Invites) != 0 || c.Store().IsEdge(fpOf(a)) {
		t.Fatal("거절하면 목록에서 빠지고 간선이 없다")
	}
	if r := c.do(t, "invite_reject", map[string]any{"id": id}); r.Status != http.StatusNotFound {
		t.Fatalf("없는 초대 = %d", r.Status)
	}
	// 같은 초대가 다시 와도(본 id 기억이 밀려난 경우) 목록에 다시 뜨지 않는다.
	c.onInvite(edgemesh.Invite{ID: id, From: fpOf(a), Name: "node-a", Expires: time.Now().Add(time.Minute)})
	if len(getView(t, c).Invites) != 0 {
		t.Fatal("거절한 초대가 다시 떴다")
	}
}

// FR-EGM-30: 노드 포트가 닫혀 있으면 초대를 보내지 못한다.
func TestInviteNeedsOpenPort(t *testing.T) {
	a, b, c := newMeshNode(t, "node-a"), newMeshNode(t, "node-b"), newMeshNode(t, "node-c")
	pairNodes(t, a, b)
	pairNodes(t, c, b)
	notify(t, a, b)
	notify(t, c, b)
	eventually(t, "A 가 C 를 안다", func() bool {
		for _, n := range getView(t, a).Mesh.Nodes {
			if n.FP == fpOf(c) && n.Online {
				return true
			}
		}
		return false
	})
	closePort(t, a)
	if r := a.do(t, "invite_send", map[string]any{"to": fpOf(c)}); r.Status != http.StatusConflict || r.Code != edge.CodePortClosed {
		t.Fatalf("포트 닫힘 = %d %s", r.Status, r.Code)
	}
}

// FR-EGM-1: 간선 계층이 없는 노드의 새 연산은 503 이다.
func TestMeshOpsWithoutMesh(t *testing.T) {
	a, b := newTestNode(t, "node-a"), newTestNode(t, "node-b")
	pairNodes(t, a, b)
	for _, op := range []string{"notify", "invite_send"} {
		r := a.do(t, op, map[string]any{"fp": fpOf(b), "to": fpOf(b)})
		if r.Status != http.StatusServiceUnavailable || r.Code != edge.CodeUnavailable {
			t.Fatalf("%s = %d %s", op, r.Status, r.Code)
		}
	}
	if v := getView(t, a); v.Mesh != nil || v.Invites == nil {
		t.Fatalf("간선 계층이 없으면 mesh 는 null, invites 는 빈 목록이다: %+v", v)
	}
}
