package ipc

import (
	"bytes"
	"encoding/json"
	"testing"

	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgenode"
	"dongminal/internal/shared/toolipc"
)

// PEER_DAEMON_SRS §3.5a — 데몬이 노드다 (FR-PDM-20·27·30·50).

func edgeServer(t *testing.T, withNode, serverSaysEdge bool) (*PanedServer, *panedConn, *bytes.Buffer) {
	t.Helper()
	ps, pc, buf := attnServer(t, false)
	pc.edge.Store(serverSaysEdge)
	if withNode {
		n, err := edgenode.New(edgenode.Options{Home: t.TempDir(), Hostname: "d", PortStatus: ps.EdgePort, Notify: ps.PushEdges})
		if err != nil {
			t.Fatal(err)
		}
		ps.SetEdge(n)
	}
	return ps, pc, buf
}

func edgeResult(t *testing.T, m map[string]json.RawMessage) toolipc.EdgeResult {
	t.Helper()
	var r toolipc.EdgeResult
	if err := json.Unmarshal(m["result"], &r); err != nil {
		t.Fatalf("result %s: %v", m["result"], err)
	}
	return r
}

func TestFeatures_SayEdge(t *testing.T) {
	if !toolipc.HasFeature(toolipc.DaemonFeatures, toolipc.FeatureEdge) {
		t.Fatal("데몬이 edge 를 말하지 않는다")
	}
}

// FR-PDM-30: edge 는 노드의 답(상태·본문·ETag)을 그대로 돌려준다.
func TestEdge_GetReturnsNodeAnswer(t *testing.T) {
	_, pc, buf := edgeServer(t, true, true)
	r := edgeResult(t, call(t, pc, buf, toolipc.MethodEdge, toolipc.EdgeParams{Op: "get"}))
	if r.Status != 200 || r.ETag == "" || len(r.Body) == 0 {
		t.Fatalf("get %+v", r)
	}
	var v struct {
		Node struct {
			Name      string `json:"name"`
			Listening bool   `json:"listening"`
		} `json:"node"`
	}
	if err := json.Unmarshal(r.Body, &v); err != nil || v.Node.Name != "d" || v.Node.Listening {
		t.Fatalf("body %s", r.Body)
	}
}

// 노드를 세우지 못한 데몬은 503 edge_unavailable 로 답한다.
func TestEdge_NoNodeIsUnavailable(t *testing.T) {
	_, pc, buf := edgeServer(t, false, true)
	r := edgeResult(t, call(t, pc, buf, toolipc.MethodEdge, toolipc.EdgeParams{Op: "get"}))
	if r.Status != 503 || r.Code != edge.CodeUnavailable {
		t.Fatalf("%+v", r)
	}
}

// FR-PDM-14: 서버가 알린 노드 포트 상태가 get 에 실린다.
func TestEdgePort_StatusShowsInGet(t *testing.T) {
	_, pc, buf := edgeServer(t, true, true)
	call(t, pc, buf, toolipc.MethodEdgePort, toolipc.EdgePortParams{Listening: true, Addr: "0.0.0.0:58147"})
	r := edgeResult(t, call(t, pc, buf, toolipc.MethodEdge, toolipc.EdgeParams{Op: "get"}))
	var v struct {
		Node struct {
			Listening bool   `json:"listening"`
			Addr      string `json:"addr"`
		} `json:"node"`
	}
	_ = json.Unmarshal(r.Body, &v)
	if !v.Node.Listening || v.Node.Addr != "0.0.0.0:58147" {
		t.Fatalf("body %s", r.Body)
	}
}

func edgesEvents(t *testing.T, buf *bytes.Buffer) []toolipc.EdgesEvent {
	t.Helper()
	var out []toolipc.EdgesEvent
	for _, m := range lines(t, buf) {
		if string(m["event"]) != `"`+toolipc.EventEdges+`"` {
			continue
		}
		raw, _ := json.Marshal(m)
		var ev toolipc.EdgesEvent
		_ = json.Unmarshal(raw, &ev)
		out = append(out, ev)
	}
	return out
}

// FR-PDM-27: 상태가 바뀌면 edges push 를 보낸다. edge 를 모르는 서버에는 보내지 않는다.
func TestEdgesPush_OnlyToEdgeServer(t *testing.T) {
	ps, _, buf := edgeServer(t, true, true)
	ps.PushEdges(edgenode.Change{Removed: &edgenode.Ref{FP: "f", Name: "b"}})
	if ev := edgesEvents(t, buf); len(ev) != 1 || ev[0].Removed == nil || ev[0].Removed.Name != "b" || ev[0].Paired != nil {
		t.Fatalf("push %+v", ev)
	}
	ps2, _, buf2 := edgeServer(t, true, false)
	ps2.PushEdges(edgenode.Change{})
	if ev := edgesEvents(t, buf2); len(ev) != 0 {
		t.Fatalf("edge 를 모르는 서버에 보냈다: %+v", ev)
	}
}
