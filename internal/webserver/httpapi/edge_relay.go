package httpapi

import (
	"encoding/json"

	"dongminal/internal/shared/dmlog"
	"dongminal/internal/shared/edgenode"
	"dongminal/internal/shared/edgerelay"
	"dongminal/internal/shared/toolipc"
)

// 노드 포트의 통로 — 데몬 모드 (PEER_DAEMON_SRS FR-PDM-10·12·33, §3.5a).
//
// 서버는 TLS 를 끝내지 않는다. 노드 포트로 받은 연결은 데몬의 노드 소켓에 잇고, 데몬의 발신은
// 발신 소켓으로 받아 TCP 로 잇는다. 노드 설정은 데몬에게 받는다.

// startEdgeRelay 는 발신 소켓과 노드 포트를 띄운다. 데몬이 노드 기능을 모르면 아무것도 열지
// 않는다 (FR-PDM-51). stop 이 닫히면 둘 다 닫는다.
func (s *Server) startEdgeRelay(stop <-chan struct{}, done chan struct{}) {
	if s.cfg.DataDir == "" || !s.EdgeDaemon.EdgeReady() {
		close(done)
		return
	}
	dialLn, err := edgerelay.ListenDial(edgerelay.DialSocketPath(s.cfg.DataDir))
	if err != nil {
		dmlog.Infof(nil, "edge relay: 발신 소켓을 열지 못했다: %v", err)
	} else {
		go edgerelay.ServeDial(dialLn)
	}
	port := edgerelay.NewPort(edgerelay.NodeSocketPath(s.cfg.DataDir))
	s.edgeKick = make(chan struct{}, 1)
	s.edgeKick <- struct{}{}
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				port.Close()
				if dialLn != nil {
					_ = dialLn.Close()
				}
				return
			case <-s.edgeKick:
				s.applyEdgePort(port)
			}
		}
	}()
}

// applyEdgePort 는 데몬의 노드 설정대로 노드 포트를 열거나 닫고, 그 상태를 데몬에 알린다
// (FR-PDM-14·33). 데몬에 닿지 않으면 지금 상태를 둔다 — 다시 붙으면 다시 부른다.
func (s *Server) applyEdgePort(port *edgerelay.Port) {
	if !s.EdgeDaemon.EdgeReady() {
		port.Apply(false, "", 0)
		return
	}
	res, err := s.EdgeDaemon.Edge(toolipc.EdgeParams{Op: "get"})
	if err != nil || res.Code != "" {
		dmlog.Infof(nil, "edge relay: 노드 설정을 읽지 못했다: %v %s", err, res.Code)
		return
	}
	var v struct {
		Node struct {
			Enabled bool   `json:"enabled"`
			Bind    string `json:"bind"`
			Port    int    `json:"port"`
		} `json:"node"`
	}
	if err := json.Unmarshal(res.Body, &v); err != nil {
		dmlog.Infof(nil, "edge relay: 노드 설정을 풀지 못했다: %v", err)
		return
	}
	port.Apply(v.Node.Enabled, v.Node.Bind, v.Node.Port)
	st := port.Status()
	if err := s.EdgeDaemon.EdgePort(toolipc.EdgePortParams{Listening: st.Listening, Addr: st.Addr, Error: st.Err}); err != nil {
		dmlog.Infof(nil, "edge relay: 노드 포트 상태를 알리지 못했다: %v", err)
	}
}

// kickEdge 는 노드 포트를 다시 맞추라고 알린다. 막지 않는다 — push 콜백(읽기 루프)에서 부른다.
func (s *Server) kickEdge() {
	if s.edgeKick == nil {
		return
	}
	select {
	case s.edgeKick <- struct{}{}:
	default:
	}
}

// EdgePushed 는 데몬의 edges push 다 (FR-PDM-27). 같은 인자로 edges_changed 를 방송하고 노드
// 포트를 다시 맞춘다. 읽기 루프에서 불리므로 데몬 RPC 를 기다리지 않는다.
func (s *Server) EdgePushed(ev toolipc.EdgesEvent) {
	c := edgenode.Change{ByPeer: ev.ByPeer}
	if r := ev.Paired; r != nil {
		c.Paired = &edgenode.Ref{FP: r.FP, Name: r.Name}
	}
	if r := ev.Removed; r != nil {
		c.Removed = &edgenode.Ref{FP: r.FP, Name: r.Name}
	}
	s.edgesChanged(c)
	s.kickEdge()
}

// EdgeResync 는 데몬에 다시 붙은 뒤다 (FR-PDM-33). 붙지 않은 동안의 push 는 잃었으므로 화면이
// 다시 읽게 하고 노드 포트를 다시 맞춘다.
func (s *Server) EdgeResync() {
	s.edgesChanged(edgenode.Change{})
	s.kickEdge()
}
