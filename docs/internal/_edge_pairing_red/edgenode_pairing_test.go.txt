package edgenode

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"dongminal/internal/shared/edge"
)

// EDGE_PAIRING_SRS — 맺기·지우기 (TC-EPR-1~5·7).

func (tn *testNode) changes() []Change {
	tn.mu.Lock()
	defer tn.mu.Unlock()
	return append([]Change{}, tn.notes...)
}

func lastPaired(tn *testNode) *Ref {
	cs := tn.changes()
	for i := len(cs) - 1; i >= 0; i-- {
		if cs[i].Paired != nil {
			return cs[i].Paired
		}
	}
	return nil
}

func lastRemoved(tn *testNode) *Ref {
	cs := tn.changes()
	for i := len(cs) - 1; i >= 0; i-- {
		if cs[i].Removed != nil {
			return cs[i].Removed
		}
	}
	return nil
}

func closePort(t *testing.T, tn *testNode) {
	t.Helper()
	cfg := tn.Config()
	cfg.Enabled = false
	raw, _ := json.Marshal(cfg)
	if r := tn.Do(context.Background(), Request{Op: "node", Args: raw}); r.Status != http.StatusOK {
		t.Fatalf("node %d %s", r.Status, r.Code)
	}
}

func inviteCode(t *testing.T, b *testNode) string {
	t.Helper()
	inv := b.do(t, "invite", map[string]any{})
	if inv.Status != http.StatusOK {
		t.Fatalf("invite %d %s", inv.Status, inv.Code)
	}
	code, _ := body(t, inv)["code"].(string)
	return code
}

// TC-EPR-1: 붙여 넣기 한 번으로 양쪽이 간선이다. A 의 노드 포트는 닫혀 있어도 된다.
func TestPairInOneStep(t *testing.T) {
	a, b := newTestNode(t, "node-a"), newTestNode(t, "node-b")
	closePort(t, a)
	add := a.do(t, "add", map[string]any{"code": inviteCode(t, b)})
	if add.Status != http.StatusOK {
		t.Fatalf("add %d %s %s", add.Status, add.Code, add.Message)
	}
	got := body(t, add)
	if got["fp"] != b.Identity().Fingerprint || got["name"] != "node-b" {
		t.Fatalf("add body %v", got)
	}
	if !a.Store().IsEdge(b.Identity().Fingerprint) || !b.Store().IsEdge(a.Identity().Fingerprint) {
		t.Fatal("양쪽이 간선이 아니다")
	}
	if p := lastPaired(b); p == nil || p.FP != a.Identity().Fingerprint || p.Name != "node-a" {
		t.Fatalf("B 의 paired = %+v", p)
	}
	if p := lastPaired(a); p == nil || p.FP != b.Identity().Fingerprint {
		t.Fatalf("A 의 paired = %+v", p)
	}
	// A 의 노드 포트가 닫혀 있었으므로 B 는 A 의 주소를 모른다 (FR-EPR-2).
	e, _ := b.Store().Resolve(a.Identity().Fingerprint)
	if e.Addr != "" || e.Port != 0 {
		t.Fatalf("B 가 저장한 A 의 주소 = %s:%d", e.Addr, e.Port)
	}
}

// TC-EPR-2: 같은 코드로 다시 시도하면 성공이다. 다른 노드는 초대가 없다.
func TestPairRetryAndStranger(t *testing.T) {
	a, b, c := newTestNode(t, "node-a"), newTestNode(t, "node-b"), newTestNode(t, "node-c")
	code := inviteCode(t, b)
	if add := a.do(t, "add", map[string]any{"code": code}); add.Status != http.StatusOK {
		t.Fatalf("add %d %s", add.Status, add.Code)
	}
	if add := a.do(t, "add", map[string]any{"code": code}); add.Status != http.StatusOK {
		t.Fatalf("다시 시도 %d %s %s", add.Status, add.Code, add.Message)
	}
	if add := c.do(t, "add", map[string]any{"code": code}); add.Status != http.StatusForbidden || add.Code != edge.CodeNoInvite {
		t.Fatalf("다른 노드 %d %s", add.Status, add.Code)
	}
	if len(b.Config().Edges) != 1 {
		t.Fatalf("B 의 간선 = %+v", b.Config().Edges)
	}
}

// TC-EPR-3: 다시 맺어도 고정한 도우미 키가 남는다.
func TestRepairKeepsHelperKey(t *testing.T) {
	a, b := newTestNode(t, "node-a"), newTestNode(t, "node-b")
	pairNodes(t, a, b)
	if err := a.Store().PinHelper(b.Identity().Fingerprint, "K"); err != nil {
		t.Fatal(err)
	}
	pairNodes(t, a, b)
	e, _ := a.Store().Resolve(b.Identity().Fingerprint)
	if e.HelperKey != "K" || len(a.Config().Edges) != 1 {
		t.Fatalf("간선 = %+v", a.Config().Edges)
	}
}

// TC-EPR-4: 한쪽에서 지우면 양쪽에서 지워진다.
func TestRemoveBothSides(t *testing.T) {
	a, b := newTestNode(t, "node-a"), newTestNode(t, "node-b")
	pairNodes(t, a, b)
	r := a.do(t, "remove", map[string]any{"fp": b.Identity().Fingerprint[:12]})
	if r.Status != http.StatusOK || body(t, r)["notified"] != true {
		t.Fatalf("remove %d %s %s", r.Status, r.Code, r.Body)
	}
	if a.Store().IsEdge(b.Identity().Fingerprint) || b.Store().IsEdge(a.Identity().Fingerprint) {
		t.Fatal("한쪽에 간선이 남았다")
	}
	if rm := lastRemoved(b); rm == nil || rm.FP != a.Identity().Fingerprint {
		t.Fatalf("B 의 removed = %+v", rm)
	}
}

// TC-EPR-5: 상대가 꺼져 있으면 자기 쪽만 지운다. 상대가 다시 걸면 edge_not_edge 를 받고,
// Forget 으로 지운다.
func TestRemoveWhileOffThenReconcile(t *testing.T) {
	a, b := newTestNodeWith(t, "node-a", http.NotFoundHandler()), newTestNode(t, "node-b")
	pairNodes(t, a, b)
	closePort(t, b)
	r := a.do(t, "remove", map[string]any{"fp": b.Identity().Fingerprint})
	if r.Status != http.StatusOK || body(t, r)["notified"] != false {
		t.Fatalf("remove %d %s", r.Status, r.Body)
	}
	if !b.Store().IsEdge(a.Identity().Fingerprint) {
		t.Fatal("시험 전제: B 에는 아직 간선이 있어야 한다")
	}
	_, err := edge.NewClient(b.Identity()).Upgrade(context.Background(), targetOf(t, a), chatPath, "dmchat1")
	if !IsNotEdge(err) {
		t.Fatalf("err = %v, edge_not_edge 를 기대", err)
	}
	b.Forget(a.Identity().Fingerprint)
	if b.Store().IsEdge(a.Identity().Fingerprint) {
		t.Fatal("Forget 이 지우지 않았다")
	}
	if rm := lastRemoved(b); rm == nil || rm.FP != a.Identity().Fingerprint {
		t.Fatalf("B 의 removed = %+v", rm)
	}
}

// TC-EPR-7: 간선이 아니면 chat·unpair 는 403 edge_not_edge, 초대 없는 pair 는 edge_no_invite.
func TestNonEdgeGetsNotEdge(t *testing.T) {
	b := newTestNodeWith(t, "node-b", http.NotFoundHandler())
	stranger := newTestNode(t, "stranger")
	cl := edge.NewClient(stranger.Identity())
	_, err := cl.Upgrade(context.Background(), targetOf(t, b), chatPath, "dmchat1")
	if !IsNotEdge(err) {
		t.Fatalf("chat err = %v", err)
	}
	err = cl.Call(context.Background(), targetOf(t, b), unpairPath, map[string]any{}, nil)
	if !IsNotEdge(err) {
		t.Fatalf("unpair err = %v", err)
	}
	err = cl.Call(context.Background(), targetOf(t, b), pairPath, map[string]any{"token": "x", "name": "s"}, nil)
	var re *edge.RemoteError
	if !errors.As(err, &re) || re.Code != edge.CodeNoInvite {
		t.Fatalf("pair err = %v", err)
	}
}

// 승인 대기 연산은 없다 (FR-EPR-53).
func TestPendingOpsGone(t *testing.T) {
	n := newTestNode(t, "node-a")
	for _, op := range []string{"pending", "approve", "reject"} {
		if r := n.do(t, op, map[string]any{}); r.Status != http.StatusNotFound {
			t.Fatalf("%s = %d", op, r.Status)
		}
	}
}
