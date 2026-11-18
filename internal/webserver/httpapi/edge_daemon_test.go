package httpapi

import (
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"dongminal/internal/daemon/ipc"
	"dongminal/internal/shared/dmenv"
	"dongminal/internal/shared/edge"
	"dongminal/internal/shared/edgenode"
	"dongminal/internal/shared/edgerelay"
	"dongminal/internal/shared/toolhub"
	"dongminal/internal/shared/toolipc"
	"dongminal/internal/webserver/toolclient"
)

// PEER_DAEMON_SRS §3.5a — 데몬 모드의 서버 (FR-PDM-20·27·30·33·50·51).

type oldEdgeDaemon struct{}

func (oldEdgeDaemon) EdgeReady() bool { return false }
func (oldEdgeDaemon) Edge(toolipc.EdgeParams) (toolipc.EdgeResult, error) {
	panic("옛 데몬에 edge 를 보냈다")
}
func (oldEdgeDaemon) EdgePort(toolipc.EdgePortParams) error {
	panic("옛 데몬에 edgeport 를 보냈다")
}

func shortHome(t *testing.T) string {
	t.Helper()
	d, err := os.MkdirTemp("", "eg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(d) })
	return d
}

// TC-PDM-10 (FR-PDM-51): edge 를 말하지 않는 데몬이면 409 edge_daemon_restart 이고 노드
// 포트·발신 소켓을 열지 않는다. 서버가 노드를 대신하지 않는다.
func TestEdgeDaemonOldDaemonNeedsRestart(t *testing.T) {
	home := shortHome(t)
	srv, err := New(Config{DataDir: home}, Deps{EdgeDaemon: oldEdgeDaemon{}})
	if err != nil {
		t.Fatal(err)
	}
	n := &edgeNode{srv: srv, home: home}
	code, out := n.api(t, http.MethodGet, "/api/edges", nil)
	if code != http.StatusConflict || errCode(out) != edge.CodeDaemonRestart {
		t.Fatalf("GET: %d %v", code, out)
	}
	stop := make(chan struct{})
	done := srv.StartEdge(stop)
	if _, err := os.Stat(edgerelay.DialSocketPath(home)); err == nil {
		t.Error("옛 데몬인데 발신 소켓을 열었다")
	}
	close(stop)
	<-done
	if _, err := os.Stat(filepath.Join(home, dmenv.EdgeKeyFile)); err == nil {
		t.Error("데몬 모드 서버가 신원을 만들었다")
	}
}

// daemonEdgeFixture 는 실제 데몬 IPC 위의 노드와, 그 데몬에 붙은 서버다.
func daemonEdgeFixture(t *testing.T, home string, cfg edge.Config) (*edgeNode, *fakeCommandBroker, *ipc.PanedServer) {
	t.Helper()
	cmds := &fakeCommandBroker{}
	n := edgeDaemonNode(t, home, cfg, cmds)
	return n, cmds, n.ps
}

// edgeDaemonNode 는 home 의 설정으로 데몬 노드를 세우고 서버를 그 데몬에 붙인다. 노드는 데몬이다
// (DIRECT_MODE_REMOVAL_SRS FR-DMR-20) — 노드 포트를 열려면 서버의 StartEdge 가 통로를 연다.
func edgeDaemonNode(t *testing.T, home string, cfg edge.Config, cmds *fakeCommandBroker) *edgeNode {
	t.Helper()
	raw, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(home, dmenv.EdgesFile), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return edgeDaemonNodeAt(t, home, cmds)
}

// edgeDaemonNodeAt 은 home 에 이미 있는 파일 그대로 데몬 노드를 세운다.
func edgeDaemonNodeAt(t *testing.T, home string, cmds *fakeCommandBroker) *edgeNode {
	t.Helper()
	pm := toolhub.NewToolManager(t.TempDir(), nil)
	t.Cleanup(pm.StopSaving)
	sock := filepath.Join(shortHome(t), "s")
	ps := ipc.NewPanedServer(pm, sock, "")
	var ln *edge.Listener
	node, err := edgenode.New(edgenode.Options{Home: home, Hostname: "d", PortStatus: ps.EdgePort, Notify: ps.PushEdges,
		OnConfig: func(c edge.Config) { ln.Apply(c) }})
	if err != nil {
		t.Fatal(err)
	}
	ln = edge.NewListener(node.Identity(), node.Admission(), node.Handler())
	ln.UseListen(func(string, int) (net.Listener, error) { return edgerelay.ListenNode(edgerelay.NodeSocketPath(home)) })
	ln.Apply(node.Config())
	t.Cleanup(ln.Close)
	ps.SetEdge(node)
	if err := ps.Listen(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ps.Close() })
	go ps.Accept()
	pc, err := toolclient.DialToolClient(sock)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pc.Close)
	srv, err := New(Config{DataDir: home}, Deps{Commands: cmds, EdgeDaemon: pc})
	if err != nil {
		t.Fatal(err)
	}
	pc.SetOnEdges(func(ev toolipc.EdgesEvent) { srv.EdgePushed(ev) })
	pc.SetOnEdgeResync(srv.EdgeResync)
	return &edgeNode{srv: srv, home: home, node: node, ps: ps}
}

func edgeWait(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("%s: 시간 초과", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TC-PDM-7·9 (FR-PDM-30·27): 로컬 API 는 데몬의 노드가 답하고, 노드의 변경은 edges push 를
// 거쳐 edges_changed 로 방송된다. ETag·stale 도 직접 모드와 같다.
func TestEdgeDaemonModeDelegates(t *testing.T) {
	home := shortHome(t)
	n, cmds, _ := daemonEdgeFixture(t, home, edge.Config{Name: "dnode", Port: freeLoopbackPort(t), Bind: "127.0.0.1"})
	code, out := n.api(t, http.MethodGet, "/api/edges", nil)
	if code != http.StatusOK {
		t.Fatalf("GET %d %v", code, out)
	}
	node, _ := out["node"].(map[string]any)
	if node["name"] != "dnode" {
		t.Fatalf("데몬의 노드가 아니다: %v", out)
	}
	rec := settingsReq(n.srv.Handler(), http.MethodGet, "/api/edges", "", "")
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("ETag 가 없다")
	}
	body := `{"name":"renamed","port":` + jsonNum(node["port"]) + `,"bind":"127.0.0.1"}`
	if r := settingsReq(n.srv.Handler(), http.MethodPut, "/api/edges/node", body, etag); r.Code != http.StatusOK {
		t.Fatalf("PUT %d %s", r.Code, r.Body)
	}
	if r := settingsReq(n.srv.Handler(), http.MethodPut, "/api/edges/node", body, etag); r.Code != http.StatusConflict || r.Header().Get("ETag") == "" {
		t.Fatalf("stale PUT %d etag=%q", r.Code, r.Header().Get("ETag"))
	}
	edgeWait(t, "edges_changed", func() bool { return len(edgesChanged(t, cmds)) > 0 })
}

func jsonNum(v any) string {
	raw, _ := json.Marshal(v)
	return string(raw)
}

// FR-PDM-33·14: StartEdge 는 데몬의 노드 설정대로 노드 포트를 열고 그 상태를 데몬에 알린다.
// 노드 포트로 온 연결은 데몬의 노드 소켓에 닿는다.
func TestEdgeDaemonModeOpensPortAndReports(t *testing.T) {
	home := shortHome(t)
	port := freeLoopbackPort(t)
	n, _, ps := daemonEdgeFixture(t, home, edge.Config{Enabled: true, Name: "dnode", Port: port, Bind: "127.0.0.1"})
	stop := make(chan struct{})
	done := n.srv.StartEdge(stop)
	t.Cleanup(func() { close(stop); <-done })
	edgeWait(t, "edgeport listening", func() bool { return ps.EdgePort().Listening })
	c, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", jsonNum(port)), time.Second)
	if err != nil {
		t.Fatalf("노드 포트에 닿지 않는다: %v", err)
	}
	_ = c.Close()
	if _, err := os.Stat(filepath.Join(home, dmenv.EdgeKeyFile)); err != nil {
		t.Fatalf("데몬의 신원이 없다: %v", err)
	}
}
