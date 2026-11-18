package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"dongminal/internal/shared/toolipc"
)

// EDGE_MESH_SRS §3.7 — 새 로컬 API 경로와 invited 방송 (TC-EGM-13).

// opEdgeDaemon 은 받은 연산 이름과 본문을 적는다.
type opEdgeDaemon struct {
	ops  []string
	args []string
}

func (d *opEdgeDaemon) EdgeReady() bool { return true }
func (d *opEdgeDaemon) Edge(p toolipc.EdgeParams) (toolipc.EdgeResult, error) {
	d.ops = append(d.ops, p.Op)
	d.args = append(d.args, string(p.Args))
	return toolipc.EdgeResult{Status: http.StatusOK, Body: json.RawMessage(`{}`)}, nil
}
func (d *opEdgeDaemon) EdgePort(toolipc.EdgePortParams) error { return nil }

func TestEdgeMeshRoutes(t *testing.T) {
	d := &opEdgeDaemon{}
	srv, err := New(Config{DataDir: shortHome(t)}, Deps{EdgeDaemon: d})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct{ path, op string }{
		{"/api/edges/notify", "notify"},
		{"/api/edges/invite/send", "invite_send"},
		{"/api/edges/invite/accept", "invite_accept"},
		{"/api/edges/invite/reject", "invite_reject"},
	}
	n := &edgeNode{srv: srv}
	for i, c := range cases {
		if code, out := n.api(t, http.MethodPost, c.path, map[string]int{"x": 1}); code != http.StatusOK {
			t.Fatalf("%s: %d %v", c.path, code, out)
		}
		if len(d.ops) != i+1 || d.ops[i] != c.op || d.args[i] != `{"x":1}` {
			t.Fatalf("%s → op %v args %v", c.path, d.ops, d.args)
		}
	}
}

// FR-EGM-64: 데몬의 edges push 의 invited 를 번호와 함께 방송한다.
func TestEdgePushedCarriesInvited(t *testing.T) {
	cmds := &fakeCommandBroker{}
	srv := &Server{}
	srv.Commands = cmds
	fp := strings.Repeat("ab", 32)
	srv.EdgePushed(toolipc.EdgesEvent{Event: toolipc.EventEdges, Invited: &toolipc.EdgeRef{FP: fp, Name: "c"}})
	got := edgesChanged(t, cmds)
	inv := refOf(got[0], "invited")
	if len(got) != 1 || inv["name"] != "c" || inv["fp"] != fp || inv["tag"] == "" {
		t.Fatalf("방송 %v", got)
	}
}
